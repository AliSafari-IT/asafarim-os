/**
 * A small, dependency-free SMTP client (RFC 5321) for plain-text messages, so
 * no service needs a third-party mail library.
 *
 * - `tls`: implicit TLS from the first byte (port 465).
 * - `starttls`: plain connect, then STARTTLS is REQUIRED before anything else
 *   is sent; a server that doesn't offer it is refused.
 * - `none`: no TLS at all, for a loopback host only (local development and
 *   tests); the caller's config enforces that.
 *
 * Certificates are always verified (Node's default). AUTH PLAIN or LOGIN,
 * only over TLS. Every step has a deadline. A CR or LF in any header value
 * is refused before connecting. Nothing it throws contains an address, the
 * message or the password.
 */
import { type Socket, connect as netConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Both or neither. */
  user?: string;
  password?: string;
  /** The name this client announces in EHLO (the sending service's host). */
  heloName: string;
  timeoutMs?: number;
}

export interface SmtpMessage {
  /** `ASafariM <no-reply@asafarim.site>` or a bare address; the envelope sender is its address. */
  from: string;
  /** Bare addresses, at least one; each is a recipient of the envelope and listed in `To:`. */
  to: readonly string[];
  subject: string;
  /** Plain text; sent as UTF-8, base64-encoded. */
  text: string;
  /** `Name <address>` or a bare address. */
  replyTo?: string;
}

export interface SmtpResult {
  /** The server's id for the accepted message (`250 … queued as <id>`, `id=<id>`, `250 Ok <id>`), when it gives one. */
  messageId?: string;
}

export class SmtpError extends Error {
  /** A short reason for the logs: an SMTP reply code or a step name. */
  readonly reason: string;

  constructor(reason: string) {
    super(`email not sent (${reason})`);
    this.name = "SmtpError";
    this.reason = reason;
  }
}

/** The address inside `Name <address>`, or the value itself. */
export function addressOf(from: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(from);
  return (m ? m[1]! : from).trim();
}

const NO_LINE_BREAKS = /^[^\r\n]*$/;
/** What goes between `<` and `>` in MAIL FROM and RCPT TO: no space, no angle bracket, no control character. */
const ENVELOPE_ADDRESS = /^[^\s<>\p{Cc}]+$/u;

/**
 * Refuses, before connecting, a message that has no recipient, a header value that could inject a header
 * (a CR or LF anywhere), or an envelope address that could inject an SMTP command argument.
 */
function check(msg: SmtpMessage): void {
  if (msg.to.length === 0) throw new SmtpError("no_recipient");
  const values = [msg.from, ...msg.to, msg.subject, ...(msg.replyTo === undefined ? [] : [msg.replyTo])];
  for (const v of values) {
    if (!NO_LINE_BREAKS.test(v)) throw new SmtpError("header_injection");
  }
  for (const address of [addressOf(msg.from), ...msg.to]) {
    if (!ENVELOPE_ADDRESS.test(address)) throw new SmtpError("bad_address");
  }
}

/** Builds the message: headers, then the body with CRLF line ends and dot-stuffing (RFC 5321 §4.5.2). */
export function buildMessage(
  msg: SmtpMessage,
  now = new Date(),
  messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}`,
): string {
  check(msg);
  const domain = addressOf(msg.from).split("@")[1] ?? "localhost";
  const subject = /^[\x20-\x7e]*$/.test(msg.subject)
    ? msg.subject
    : `=?UTF-8?B?${Buffer.from(msg.subject, "utf8").toString("base64")}?=`;
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.map((to) => `<${to}>`).join(", ")}`,
    ...(msg.replyTo === undefined ? [] : [`Reply-To: ${msg.replyTo}`]),
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${messageId}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  // base64 keeps every line short and ASCII whatever the text holds; 76 characters per line.
  const body = (
    Buffer.from(msg.text.replace(/\r?\n/g, "\r\n"), "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/** The server's id for the message, from its reply to the end of DATA; only a short, plain token. */
export function serverMessageId(reply: readonly string[]): string | undefined {
  const text = (reply[reply.length - 1] ?? "").slice(4).replace(/^\d\.\d{1,3}\.\d{1,3}\s+/, "");
  const m =
    /\bqueued as\s+<?([^\s<>]+?)>?(?:\s|$)/i.exec(text) ??
    /\bid=<?([^\s<>]+?)>?(?:\s|$)/i.exec(text) ??
    /^ok\s+<?([^\s<>]+?)>?$/i.exec(text.trim());
  const id = m?.[1];
  return id && /^[\x21-\x7e]{1,255}$/.test(id) ? id : undefined;
}

interface Reply {
  code: number;
  lines: string[];
}

/** Line-oriented reading of SMTP replies (multi-line: `250-…` continues, `250 …` ends). */
class Conversation {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private readonly lines: string[] = [];
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("latin1");
    if (this.buffer.length > 64 * 1024) this.fail(new SmtpError("reply_too_long"));
    let i: number;
    while ((i = this.buffer.indexOf("\r\n")) >= 0) {
      this.lines.push(this.buffer.slice(0, i));
      this.buffer = this.buffer.slice(i + 2);
    }
    this.wake();
  };
  private readonly onError = (err: Error) => this.fail(err);
  private readonly onClose = () => this.fail(new SmtpError("connection_closed"));

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach();
  }

  private attach() {
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
  }

  private detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  fail(err: Error) {
    this.failure ??= err;
    this.wake();
  }

  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private async nextLine(): Promise<string> {
    while (this.lines.length === 0) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
    return this.lines.shift()!;
  }

  async read(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) {
        const code = Number(line.slice(0, 3));
        if (!Number.isInteger(code)) throw new SmtpError("bad_reply");
        return { code, lines };
      }
    }
  }

  async command(line: string, expect: number[], step: string): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(expect, step);
  }

  async expect(expect: number[], step: string): Promise<Reply> {
    const reply = await this.read();
    if (!expect.includes(reply.code)) throw new SmtpError(`${step}_${reply.code}`);
    return reply;
  }

  write(data: string) {
    this.socket.write(data);
  }

  /** STARTTLS: hand the plain socket to TLS and keep talking on the encrypted one. */
  async upgrade(host: string): Promise<void> {
    if (this.lines.length || this.buffer) throw new SmtpError("starttls_pipelining");
    this.detach();
    const plain = this.socket;
    const secure = tlsConnect({ socket: plain as Socket, servername: host });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", (err) => reject(err));
      secure.once("close", () => reject(new SmtpError("tls")));
    });
    this.socket = secure;
    this.attach();
  }

  get encrypted(): boolean {
    return (this.socket as TLSSocket).encrypted === true;
  }

  destroy() {
    this.detach();
    this.socket.destroy();
  }
}

function open(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      config.security === "tls"
        ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
        : netConnect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

const extensions = (reply: Reply) => reply.lines.map((l) => l.slice(4).toUpperCase());

export class SmtpClient {
  private readonly config: SmtpConfig;

  constructor(config: SmtpConfig) {
    if (Boolean(config.user) !== Boolean(config.password)) throw new Error("SMTP user and password: both or neither");
    this.config = config;
  }

  async send(message: SmtpMessage): Promise<SmtpResult> {
    const c = this.config;
    const data = buildMessage(message);
    let socket: Socket | TLSSocket;
    try {
      socket = await open(c);
    } catch {
      throw new SmtpError("connect");
    }
    const talk = new Conversation(socket);
    const timer = setTimeout(() => {
      talk.fail(new SmtpError("timeout"));
      talk.destroy();
    }, c.timeoutMs ?? 15_000);
    try {
      await talk.expect([220], "greeting");
      let ehlo = await talk.command(`EHLO ${c.heloName}`, [250], "ehlo");
      if (c.security === "starttls") {
        if (!extensions(ehlo).some((e) => e === "STARTTLS")) throw new SmtpError("starttls_unavailable");
        await talk.command("STARTTLS", [220], "starttls");
        try {
          await talk.upgrade(c.host);
        } catch (err) {
          throw err instanceof SmtpError ? err : new SmtpError("tls");
        }
        ehlo = await talk.command(`EHLO ${c.heloName}`, [250], "ehlo");
      }
      if (c.user && c.password) {
        if (!talk.encrypted) throw new SmtpError("auth_without_tls");
        const auth = extensions(ehlo).find((e) => e.startsWith("AUTH")) ?? "";
        if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
          const token = Buffer.from(`\0${c.user}\0${c.password}`, "utf8").toString("base64");
          await talk.command(`AUTH PLAIN ${token}`, [235], "auth");
        } else {
          await talk.command("AUTH LOGIN", [334], "auth");
          await talk.command(Buffer.from(c.user, "utf8").toString("base64"), [334], "auth");
          await talk.command(Buffer.from(c.password, "utf8").toString("base64"), [235], "auth");
        }
      }
      await talk.command(`MAIL FROM:<${addressOf(message.from)}>`, [250], "mail_from");
      for (const to of message.to) await talk.command(`RCPT TO:<${to}>`, [250, 251], "rcpt_to");
      await talk.command("DATA", [354], "data");
      talk.write(`${data}\r\n.\r\n`);
      const accepted = await talk.expect([250], "data_end");
      try {
        await talk.command("QUIT", [221], "quit");
      } catch {
        // The message is accepted; a server that hangs up instead of saying goodbye is fine.
      }
      const messageId = serverMessageId(accepted.lines);
      return messageId === undefined ? {} : { messageId };
    } catch (err) {
      throw err instanceof SmtpError ? err : new SmtpError("smtp");
    } finally {
      clearTimeout(timer);
      talk.destroy();
    }
  }
}
