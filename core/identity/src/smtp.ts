/**
 * A small SMTP client for one job: sending a sign-in code (RFC 5321, plain
 * text). No dependency, so the service keeps no third-party mail library.
 *
 * - `tls`: implicit TLS from the first byte (port 465).
 * - `starttls`: plain connect, then STARTTLS is REQUIRED before anything else
 *   is sent; a server that doesn't offer it is refused.
 * - `none`: no TLS at all, allowed by config only for a loopback host (local
 *   development and tests).
 *
 * Certificates are always verified (Node's default). AUTH PLAIN or LOGIN,
 * only over TLS. Every step has a deadline. Nothing it logs or throws
 * contains the address, the code or the password.
 */
import { Socket, connect as netConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Both or neither. */
  user?: string;
  password?: string;
  /** `ASafariM <no-reply@asafarim.site>` or a bare address. */
  from: string;
  /** The name this client announces in EHLO (the issuer's host). */
  heloName: string;
  timeoutMs?: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class MailError extends Error {
  /** A short reason for the logs: an SMTP reply code or a step name. */
  readonly reason: string;

  constructor(reason: string) {
    super(`email not sent (${reason})`);
    this.name = "MailError";
    this.reason = reason;
  }
}

/** The address inside `Name <address>`, or the value itself. */
export function addressOf(from: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(from);
  return (m ? m[1]! : from).trim();
}

const NO_LINE_BREAKS = /^[^\r\n]*$/;

/** Builds the message: headers, then the body with CRLF line ends and dot-stuffing (RFC 5321 §4.5.2). */
export function buildMessage(
  from: string,
  msg: MailMessage,
  now = new Date(),
  messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}`,
): string {
  for (const v of [from, msg.to, msg.subject]) {
    if (!NO_LINE_BREAKS.test(v)) throw new MailError("header_injection");
  }
  const domain = addressOf(from).split("@")[1] ?? "localhost";
  const subject = /^[\x20-\x7e]*$/.test(msg.subject)
    ? msg.subject
    : `=?UTF-8?B?${Buffer.from(msg.subject, "utf8").toString("base64")}?=`;
  const headers = [
    `From: ${from}`,
    `To: <${msg.to}>`,
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
    if (this.buffer.length > 64 * 1024) this.fail(new MailError("reply_too_long"));
    let i: number;
    while ((i = this.buffer.indexOf("\r\n")) >= 0) {
      this.lines.push(this.buffer.slice(0, i));
      this.buffer = this.buffer.slice(i + 2);
    }
    this.wake();
  };
  private readonly onError = (err: Error) => this.fail(err);
  private readonly onClose = () => this.fail(new MailError("connection_closed"));

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
        if (!Number.isInteger(code)) throw new MailError("bad_reply");
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
    if (!expect.includes(reply.code)) throw new MailError(`${step}_${reply.code}`);
    return reply;
  }

  write(data: string) {
    this.socket.write(data);
  }

  /** STARTTLS: hand the plain socket to TLS and keep talking on the encrypted one. */
  async upgrade(host: string): Promise<void> {
    if (this.lines.length || this.buffer) throw new MailError("starttls_pipelining");
    this.detach();
    const plain = this.socket;
    const secure = tlsConnect({ socket: plain as Socket, servername: host });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", (err) => reject(err));
      secure.once("close", () => reject(new MailError("tls")));
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

export class SmtpMailer implements Mailer {
  private readonly config: SmtpConfig;

  constructor(config: SmtpConfig) {
    if (Boolean(config.user) !== Boolean(config.password)) throw new Error("SMTP user and password: both or neither");
    this.config = config;
  }

  async send(message: MailMessage): Promise<void> {
    const c = this.config;
    const data = buildMessage(c.from, message);
    let socket: Socket | TLSSocket;
    try {
      socket = await open(c);
    } catch {
      throw new MailError("connect");
    }
    const talk = new Conversation(socket);
    const timer = setTimeout(() => {
      talk.fail(new MailError("timeout"));
      talk.destroy();
    }, c.timeoutMs ?? 15_000);
    try {
      await talk.expect([220], "greeting");
      let ehlo = await talk.command(`EHLO ${c.heloName}`, [250], "ehlo");
      if (c.security === "starttls") {
        if (!extensions(ehlo).some((e) => e === "STARTTLS")) throw new MailError("starttls_unavailable");
        await talk.command("STARTTLS", [220], "starttls");
        try {
          await talk.upgrade(c.host);
        } catch (err) {
          throw err instanceof MailError ? err : new MailError("tls");
        }
        ehlo = await talk.command(`EHLO ${c.heloName}`, [250], "ehlo");
      }
      if (c.user && c.password) {
        if (!talk.encrypted) throw new MailError("auth_without_tls");
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
      await talk.command(`MAIL FROM:<${addressOf(c.from)}>`, [250], "mail_from");
      await talk.command(`RCPT TO:<${message.to}>`, [250, 251], "rcpt_to");
      await talk.command("DATA", [354], "data");
      talk.write(`${data}\r\n.\r\n`);
      await talk.expect([250], "data_end");
      try {
        await talk.command("QUIT", [221], "quit");
      } catch {
        // The message is accepted; a server that hangs up instead of saying goodbye is fine.
      }
    } catch (err) {
      throw err instanceof MailError ? err : new MailError("smtp");
    } finally {
      clearTimeout(timer);
      talk.destroy();
    }
  }
}

/**
 * Development only (config refuses it unless NODE_ENV=development on
 * localhost): writes the first line of the message to stderr instead of
 * sending it.
 */
export class DevLogMailer implements Mailer {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
    this.write = write;
  }

  async send(message: MailMessage): Promise<void> {
    this.write(`[dev email] to ${message.to}: ${message.subject}`);
  }
}
