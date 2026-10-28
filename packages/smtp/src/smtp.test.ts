import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { SmtpClient, SmtpError, addressOf, buildMessage, serverMessageId } from "./smtp.ts";

const message = { from: "ASafariM <no-reply@asafarim.site>", to: ["a@b.c"], subject: "Hi", text: ".hi" };

/** A tiny SMTP server on loopback that records the conversation. */
async function fakeServer(script: { ehlo: string[]; dataEnd?: string }) {
  const seen: string[] = [];
  let connections = 0;
  const server = createServer((socket: Socket) => {
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
            socket.write(`${script.dataEnd ?? "250 queued"}\r\n`);
          }
          continue;
        }
        if (line.startsWith("EHLO"))
          socket.write(script.ehlo.map((e, n) => `250${n === script.ehlo.length - 1 ? " " : "-"}${e}\r\n`).join(""));
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 no\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    server,
    port: (server.address() as { port: number }).port,
    connections: () => connections,
  };
}

const loopback = (port: number) => new SmtpClient({ host: "127.0.0.1", port, security: "none", heloName: "id.test" });

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SmtpError);
    return (e as SmtpError).reason;
  }
  throw new Error("expected the send to fail");
}

describe("buildMessage", () => {
  it("builds a message that is dot-safe, with the headers in order", () => {
    const m = buildMessage(message);
    expect(m).toContain("From: ASafariM <no-reply@asafarim.site>\r\nTo: <a@b.c>\r\nSubject: Hi");
    expect(m.split("\r\n").some((l) => l.startsWith("."))).toBe(false);
    expect(addressOf("ASafariM <no-reply@asafarim.site>")).toBe("no-reply@asafarim.site");
  });

  it("is byte for byte what identity sent before, for one recipient and no Reply-To", () => {
    const m = buildMessage(
      { from: "ASafariM <no-reply@asafarim.site>", to: ["a@example.test"], subject: "Code", text: "Line 1\nLine 2" },
      new Date("2026-01-02T03:04:05Z"),
      "fixed",
    );
    expect(m).toBe(
      [
        "From: ASafariM <no-reply@asafarim.site>",
        "To: <a@example.test>",
        "Subject: Code",
        "Date: Fri, 02 Jan 2026 03:04:05 GMT",
        "Message-ID: <fixed@asafarim.site>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "Auto-Submitted: auto-generated",
        "",
        Buffer.from("Line 1\r\nLine 2", "utf8").toString("base64"),
      ].join("\r\n"),
    );
  });

  it("lists every recipient in To: and adds Reply-To when given", () => {
    const m = buildMessage({ ...message, to: ["a@b.c", "d@e.f"], replyTo: "Support <help@b.c>" });
    expect(m).toContain("To: <a@b.c>, <d@e.f>\r\nReply-To: Support <help@b.c>\r\nSubject: Hi");
  });

  it("encodes a non-ASCII subject (RFC 2047)", () => {
    const m = buildMessage({ ...message, subject: "Café" });
    expect(m).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café", "utf8").toString("base64")}?=`);
  });

  it("refuses a CR or LF in any header value", () => {
    for (const bad of ["x\r\nBcc: e@f.g", "x\nBcc: e@f.g", "x\rBcc: e@f.g"]) {
      for (const msg of [
        { ...message, from: `a@b.c${bad}` },
        { ...message, to: [`a@b.c${bad}`] },
        { ...message, to: ["a@b.c", `d@e.f${bad}`] },
        { ...message, subject: `Hi${bad}` },
        { ...message, replyTo: `r@b.c${bad}` },
      ]) {
        expect(() => buildMessage(msg)).toThrow(expect.objectContaining({ reason: "header_injection" }));
      }
    }
  });

  it("refuses an envelope address that could add an SMTP argument, and a message with no recipient", () => {
    for (const msg of [
      { ...message, to: ["a@b.c> NOTIFY=SUCCESS"] },
      { ...message, to: ["a@b.c>"] },
      { ...message, from: "x <a@b.c> y" },
      { ...message, to: ["a\t@b.c"] },
    ]) {
      expect(() => buildMessage(msg)).toThrow(expect.objectContaining({ reason: "bad_address" }));
    }
    expect(() => buildMessage({ ...message, to: [] })).toThrow(expect.objectContaining({ reason: "no_recipient" }));
  });
});

describe("serverMessageId", () => {
  it("reads the id the common servers give, and nothing else", () => {
    expect(serverMessageId(["250 2.0.0 Ok: queued as 4ABCD1234"])).toBe("4ABCD1234");
    expect(serverMessageId(["250 OK id=1qXyZ-000abc-0A"])).toBe("1qXyZ-000abc-0A");
    expect(serverMessageId(["250 Ok 0100018a-1b2c3d4e-0000"])).toBe("0100018a-1b2c3d4e-0000");
    expect(serverMessageId(["250 2.0.0 Ok: queued as <x.y@z>"])).toBe("x.y@z");
    expect(serverMessageId(["250 queued"])).toBeUndefined();
    expect(serverMessageId(["250 2.0.0 OK  1698765432 a1-20020a gsmtp"])).toBeUndefined();
    expect(serverMessageId([])).toBeUndefined();
  });
});

describe("SmtpClient", () => {
  it("delivers over a plain loopback connection (development) without AUTH", async () => {
    const f = await fakeServer({ ehlo: ["fake", "8BITMIME"] });
    try {
      const result = await loopback(f.port).send({
        from: "ASafariM <no-reply@asafarim.site>",
        to: ["a@example.test"],
        subject: "Code",
        text: "Your code is 123456.",
      });
      expect(result).toEqual({});
      expect(f.seen).toEqual(
        expect.arrayContaining([
          "EHLO id.test",
          "MAIL FROM:<no-reply@asafarim.site>",
          "RCPT TO:<a@example.test>",
          "DATA",
          ".",
        ]),
      );
    } finally {
      f.server.close();
    }
  });

  it("names every recipient in the envelope and returns the server's message id", async () => {
    const f = await fakeServer({ ehlo: ["fake"], dataEnd: "250 2.0.0 Ok: queued as 7F3A2B" });
    try {
      const result = await loopback(f.port).send({ ...message, to: ["a@example.test", "b@example.test"] });
      expect(result).toEqual({ messageId: "7F3A2B" });
      expect(f.seen.filter((l) => l.startsWith("RCPT"))).toEqual([
        "RCPT TO:<a@example.test>",
        "RCPT TO:<b@example.test>",
      ]);
    } finally {
      f.server.close();
    }
  });

  it("connects where `lookup` says, whatever the host name resolves to", async () => {
    const f = await fakeServer({ ehlo: ["fake"] });
    const asked: string[] = [];
    try {
      const client = new SmtpClient({
        host: "mail.pinned.test",
        port: f.port,
        security: "none",
        heloName: "id.test",
        lookup: ((host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          asked.push(host);
          if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        }) as never,
      });
      expect(await client.send(message)).toEqual({});
      expect(asked).toEqual(["mail.pinned.test"]);
      expect(f.connections()).toBe(1);
    } finally {
      f.server.close();
    }
  });

  it("refuses header injection before connecting", async () => {
    const f = await fakeServer({ ehlo: ["fake"] });
    try {
      expect(await reasonOf(loopback(f.port).send({ ...message, subject: "Hi\r\nBcc: e@f.g" }))).toBe(
        "header_injection",
      );
      expect(f.connections()).toBe(0);
    } finally {
      f.server.close();
    }
  });

  it("refuses to go on when STARTTLS is required but not offered, and never sends a password in clear", async () => {
    const f = await fakeServer({ ehlo: ["fake", "AUTH PLAIN"] });
    try {
      const client = new SmtpClient({
        host: "127.0.0.1",
        port: f.port,
        security: "starttls",
        user: "u",
        password: "secret-password",
        heloName: "id.test",
      });
      expect(await reasonOf(client.send({ ...message, from: "x@y.z" }))).toBe("starttls_unavailable");
      expect(f.seen.some((l) => l.startsWith("AUTH"))).toBe(false);
    } finally {
      f.server.close();
    }
  });

  it("refuses AUTH over a connection without TLS", async () => {
    const f = await fakeServer({ ehlo: ["fake", "AUTH PLAIN"] });
    try {
      const client = new SmtpClient({
        host: "127.0.0.1",
        port: f.port,
        security: "none",
        user: "u",
        password: "secret-password",
        heloName: "id.test",
      });
      expect(await reasonOf(client.send(message))).toBe("auth_without_tls");
      expect(f.seen.some((l) => l.startsWith("AUTH"))).toBe(false);
    } finally {
      f.server.close();
    }
  });

  it("needs a user and a password together", () => {
    expect(() => new SmtpClient({ host: "h", port: 465, security: "tls", user: "u", heloName: "x" })).toThrow();
  });
});
