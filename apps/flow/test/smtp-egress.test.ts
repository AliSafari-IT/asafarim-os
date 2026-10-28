/**
 * Email out (lib/egress/smtp.ts) against a local SMTP stand-in on loopback: the server's addresses are
 * checked like egress's (a private or reserved one refused before connecting) and the connection pinned
 * to them; `none` (no TLS) only for a loopback server and never in production; Pause all; SMTP's answers
 * as codes; one connector_calls row and one log line per call, with no address, subject or secret.
 */
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SmtpError } from "@asafarim/smtp";
import {
  codeOfSmtpReason,
  createSmtpEgress,
  isLoopbackAddress,
  SmtpEgressError,
  type MailRequest,
} from "../lib/egress/smtp";

/** The SMTP stand-in: accepts everything, or answers `reply` to the step it names. */
let server: Server;
let port: number;
let seen: string[] = [];
let connections = 0;
let reject: { step: "MAIL" | "RCPT" | "DATA_END"; reply: string } | undefined;

beforeAll(async () => {
  server = createServer((socket: Socket) => {
    connections++;
    let data = false;
    let buffer = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        seen.push(line);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write(reject?.step === "DATA_END" ? `${reject.reply}\r\n` : "250 2.0.0 Ok: queued as ABC123\r\n");
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250 fake\r\n");
        else if (line.startsWith("MAIL")) socket.write(reject?.step === "MAIL" ? `${reject.reply}\r\n` : "250 ok\r\n");
        else if (line.startsWith("RCPT")) socket.write(reject?.step === "RCPT" ? `${reject.reply}\r\n` : "250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 no\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

const rows: unknown[][] = [];
const settings = { pausedAll: false };
const db = {
  async query(text: string, values: unknown[] = []) {
    if (text.includes("FROM settings WHERE key = 'paused_all'"))
      return { rows: settings.pausedAll ? [{ value: true }] : [] };
    if (text.includes("INSERT INTO connector_calls")) {
      rows.push(values);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  },
};
const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
const log = {
  info: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
  warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
};

beforeEach(() => {
  seen = [];
  connections = 0;
  reject = undefined;
  rows.length = 0;
  logs.length = 0;
  settings.pausedAll = false;
});

const PASSWORD = "smtp-PASS-77aa11";
const mail = (server: Partial<MailRequest["server"]> = {}): MailRequest => ({
  server: { host: "localhost", port, mode: "none", username: "user-x", password: PASSWORD, ...server },
  message: { from: "Flow <flow@example.com>", to: ["ada@example.com"], subject: "Private subject", text: "Body" },
  call: { connector: "email.send", runId: "r1", stepId: "s1" },
});
const loopbackOnly = { resolve: async () => [{ address: "127.0.0.1", family: 4 as const }], log };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SmtpEgressError);
    return (err as SmtpEgressError).code;
  }
  throw new Error("expected the send to fail");
}

describe("email out", () => {
  it("sends to a loopback server without TLS (development), without AUTH; one row, one log line", async () => {
    const smtp = createSmtpEgress({ ...loopbackOnly, env: { NODE_ENV: "development" } });
    expect(await smtp.send(db, mail())).toEqual({ messageId: "ABC123" });
    expect(seen).toEqual(
      expect.arrayContaining(["EHLO example.com", "MAIL FROM:<flow@example.com>", "RCPT TO:<ada@example.com>"]),
    );
    expect(seen.some((l) => l.startsWith("AUTH"))).toBe(false);
    expect(rows).toEqual([[expect.any(String), "r1", "s1", "email.send", "localhost", null, expect.any(Number), null]]);
    expect(logs).toEqual([
      { msg: "egress.call", fields: expect.objectContaining({ host: "localhost", protocol: "smtp" }) },
    ]);
    const text = JSON.stringify([rows, logs]);
    for (const s of ["ada@example.com", "Private subject", PASSWORD, "user-x"]) expect(text).not.toContain(s);
  });

  it("the connection goes to the checked address, whatever the name would resolve to later", async () => {
    let asked = 0;
    const smtp = createSmtpEgress({
      resolve: async () =>
        asked++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }],
      env: {},
      log,
    });
    await smtp.send(db, mail());
    expect(asked).toBe(1);
    expect(connections).toBe(1);
  });

  it("`none` is refused for a server that isn't loopback, and in production; nothing is connected", async () => {
    const dev = createSmtpEgress({ ...loopbackOnly, env: {} });
    expect(await codeOf(dev.send(db, mail({ host: "smtp.example.com" })))).toBe("insecure_refused");
    const prod = createSmtpEgress({ ...loopbackOnly, env: { NODE_ENV: "production" } });
    expect(await codeOf(prod.send(db, mail()))).toBe("insecure_refused");
    // A loopback name that resolves elsewhere.
    const lying = createSmtpEgress({ resolve: async () => [{ address: "192.0.2.10", family: 4 }], env: {}, log });
    expect(await codeOf(lying.send(db, mail()))).toBe("insecure_refused");
    expect(connections).toBe(0);
    expect(rows.map((r) => r[7])).toEqual(["insecure_refused", "insecure_refused", "insecure_refused"]);
  });

  it("with TLS, a server resolving to a private or reserved address (any one of them) is private_address", async () => {
    for (const address of ["10.1.2.3", "169.254.169.254", "127.0.0.1", "::1", "fd00::1"]) {
      const smtp = createSmtpEgress({
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address, family: address.includes(":") ? 6 : 4 },
        ],
        env: {},
        log,
      });
      expect(await codeOf(smtp.send(db, mail({ host: "smtp.example.com", mode: "starttls" })))).toBe("private_address");
    }
    expect(connections).toBe(0);
  });

  it("a name that doesn't resolve is dns_failed (retryable)", async () => {
    const smtp = createSmtpEgress({
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
      env: {},
      log,
    });
    const err = await smtp.send(db, mail({ host: "smtp.example.com", mode: "tls" })).catch((e: SmtpEgressError) => e);
    expect(err).toMatchObject({ code: "dns_failed", retryable: true });
  });

  it("Pause all: nothing is sent", async () => {
    settings.pausedAll = true;
    expect(await codeOf(createSmtpEgress({ ...loopbackOnly, env: {} }).send(db, mail()))).toBe("paused_all");
    expect(connections).toBe(0);
  });

  it("SMTP's answers: 4xx smtp_unavailable (retryable), 5xx smtp_rejected", async () => {
    const smtp = createSmtpEgress({ ...loopbackOnly, env: {} });
    reject = { step: "RCPT", reply: "451 try later" };
    expect(await smtp.send(db, mail()).catch((e: SmtpEgressError) => e)).toMatchObject({
      code: "smtp_unavailable",
      retryable: true,
    });
    reject = { step: "DATA_END", reply: "554 no" };
    expect(await smtp.send(db, mail()).catch((e: SmtpEgressError) => e)).toMatchObject({
      code: "smtp_rejected",
      retryable: false,
    });
    // Nobody listening.
    expect(await codeOf(smtp.send(db, mail({ port: 1 })))).toBe("smtp_unavailable");
  });

  it("auth refused is smtp_auth; TLS problems smtp_tls; header injection invalid_message", async () => {
    const cases: [string, string][] = [
      ["auth_535", "smtp_auth"],
      ["auth_454", "smtp_auth"],
      ["starttls_unavailable", "smtp_tls"],
      ["tls", "smtp_tls"],
      ["header_injection", "invalid_message"],
      ["connect", "smtp_unavailable"],
      ["timeout", "smtp_unavailable"],
      ["greeting_421", "smtp_unavailable"],
      ["mail_from_550", "smtp_rejected"],
    ];
    for (const [reason, code] of cases) {
      expect(codeOfSmtpReason(reason)).toBe(code);
      const smtp = createSmtpEgress({
        ...loopbackOnly,
        env: {},
        send: async () => {
          throw new SmtpError(reason);
        },
      });
      expect(await codeOf(smtp.send(db, mail()))).toBe(code);
    }
  });

  it("with TLS the credential's login is passed on; never with `none`", async () => {
    const configs: unknown[] = [];
    const smtp = createSmtpEgress({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      env: {},
      log,
      send: async (config) => {
        configs.push(config);
        return {};
      },
    });
    await smtp.send(db, mail({ host: "smtp.example.com", mode: "tls" }));
    expect(configs[0]).toMatchObject({ host: "smtp.example.com", security: "tls", user: "user-x", password: PASSWORD });
    await createSmtpEgress({ ...loopbackOnly, env: {}, send: async (c) => (configs.push(c), {}) }).send(db, mail());
    expect(configs[1]).not.toHaveProperty("password");
  });

  it("loopback addresses", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ["10.0.0.1", "::2", "128.0.0.1"]) expect(isLoopbackAddress(a)).toBe(false);
  });
});
