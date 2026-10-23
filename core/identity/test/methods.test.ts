import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { decodeCbor } from "../src/cbor.ts";
import { ConfigError, parseLocalLogin } from "../src/config.ts";
import { maskEmail, normalizeEmail } from "../src/email.ts";
import { blindHandle, generateCode, hashCode, isCodeShaped } from "../src/otp.ts";
import { maskPhone, normalizePhone, parsePrefixes, prefixAllowed } from "../src/phone.ts";
import { DevLogSmsSender, SmsError, TwilioSmsSender, codeMessage } from "../src/sms.ts";
import { FAVICON_SVG, errorPage, loggedOutPage, page, setHomeUrl } from "../src/pages.ts";
import { PAGE_CSP, accountPage, adminPage, codePage, loginPage } from "../src/sign-in-pages.ts";
import { MailError, SmtpMailer, addressOf, buildMessage } from "../src/smtp.ts";
import { encodeCbor } from "./authenticator.ts";

describe("phone numbers", () => {
  it("normalizes what people type to E.164", () => {
    expect(normalizePhone("+32 470 12 34 56")).toBe("+32470123456");
    expect(normalizePhone("0032 470/12.34.56")).toBe("+32470123456");
    expect(normalizePhone("(+32) 470-123456")).toBe("+32470123456");
    expect(normalizePhone(" +1 (415) 555-0100 ")).toBe("+14155550100");
  });

  it("refuses national numbers, letters, and anything too short or too long", () => {
    for (const bad of [
      "0470123456",
      "470123456",
      "+32 470 ABC",
      "+0470123456",
      "+3247",
      "+1234567890123456",
      "",
      "++32470123456",
    ]) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
  });

  it("parses the allowed prefixes and checks them", () => {
    expect(parsePrefixes("+32, +31")).toEqual(["+32", "+31"]);
    expect(() => parsePrefixes("")).toThrow();
    expect(() => parsePrefixes("32")).toThrow();
    expect(prefixAllowed("+32470123456", ["+32"])).toBe(true);
    expect(prefixAllowed("+33612345678", ["+32", "+31"])).toBe(false);
  });

  it("masks a number down to its country and last two digits", () => {
    expect(maskPhone("+32470123456")).toBe("+32 ••• ••• 56");
    expect(maskPhone("+14155550100")).toBe("+1 ••• ••• 00");
  });
});

describe("codes", () => {
  it("are 6 digits", () => {
    for (let i = 0; i < 200; i++) expect(isCodeShaped(generateCode())).toBe(true);
    expect(isCodeShaped("12345")).toBe(false);
    expect(isCodeShaped("12345a")).toBe(false);
  });

  it("are stored as an HMAC bound to the challenge and the number", () => {
    const h = hashCode("s".repeat(32), "c1", "+32470123456", "123456");
    expect(h).not.toContain("123456");
    expect(hashCode("s".repeat(32), "c2", "+32470123456", "123456")).not.toBe(h);
    expect(hashCode("s".repeat(32), "c1", "+32470123457", "123456")).not.toBe(h);
    expect(hashCode("t".repeat(32), "c1", "+32470123456", "123456")).not.toBe(h);
    expect(hashCode("s".repeat(32), "c1", "+32470123456", "123456")).toBe(h);
  });

  it("blind handles hide the value and differ by kind", () => {
    const a = blindHandle("s".repeat(32), "phone", "+32470123456");
    expect(a).not.toContain("470123456");
    expect(blindHandle("s".repeat(32), "ip", "+32470123456")).not.toBe(a);
  });
});

describe("SMS sending", () => {
  it("writes the code and the one-time-code line for this site only", () => {
    expect(codeMessage("123456", "id.asafarim.site", 5)).toBe(
      "Your ASafariM sign-in code is 123456. It expires in 5 minutes. Never share it with anyone.\n\n@id.asafarim.site #123456",
    );
  });

  it("posts to Twilio's Messages API with basic auth", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const sid = `AC${"a".repeat(32)}`;
    await new TwilioSmsSender({ accountSid: sid, authToken: "tok", from: "+3220000000" }, fakeFetch).send(
      "+32470123456",
      "hi",
    );
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from(`${sid}:tok`).toString("base64")}`,
    );
    const body = calls[0]!.init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ To: "+32470123456", Body: "hi", From: "+3220000000" });

    await new TwilioSmsSender({ accountSid: sid, authToken: "tok", from: `MG${"b".repeat(32)}` }, fakeFetch).send(
      "+32470123456",
      "hi",
    );
    expect((calls[1]!.init.body as URLSearchParams).get("MessagingServiceSid")).toBe(`MG${"b".repeat(32)}`);
  });

  it("turns a refusal into an SmsError carrying only the status and the provider's code", async () => {
    const refusing = (async () =>
      new Response(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number: +32470123456" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const sender = new TwilioSmsSender({ accountSid: `AC${"a".repeat(32)}`, authToken: "t", from: "x" }, refusing);
    let error: unknown;
    try {
      await sender.send("+32470123456", "hi");
    } catch (e) {
      error = e;
    }
    expect(error instanceof SmsError).toBe(true);
    expect((error as SmsError).reason).toBe("http_400:21211");
    expect((error as SmsError).message).not.toContain("470123456");
  });

  it("the dev sender only writes a line", async () => {
    const lines: string[] = [];
    await new DevLogSmsSender((l) => lines.push(l)).send("+32470123456", codeMessage("123456", "localhost", 5));
    expect(lines).toHaveLength(1);
  });
});

describe("email addresses", () => {
  it("normalizes to lower case and refuses what isn't an address", () => {
    expect(normalizeEmail("  Ali.Safari@Example.COM ")).toBe("ali.safari@example.com");
    for (const bad of ["", "ali", "ali@", "@example.com", "a b@example.com", "ali@example", "<ali@example.com>"]) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    expect(maskEmail("ali.safari@example.com")).toBe("a•••i@example.com");
  });
});

describe("CBOR", () => {
  it("round-trips what WebAuthn uses and refuses the rest", () => {
    const value = new Map<unknown, unknown>([
      [1, 2],
      [-1, 1],
      ["fmt", "none"],
      [-2, Buffer.alloc(32, 7)],
    ]);
    const { value: back, end } = decodeCbor(encodeCbor(value as never));
    expect(end).toBe(encodeCbor(value as never).length);
    expect((back as Map<unknown, unknown>).get("fmt")).toBe("none");
    expect((back as Map<unknown, unknown>).get(-1)).toBe(1);
    expect(() => decodeCbor(Buffer.from([0x5f]))).toThrow(); // indefinite length
    expect(() => decodeCbor(Buffer.from([0xc0, 0x00]))).toThrow(); // a tag
    expect(() => decodeCbor(Buffer.from([0x42, 0x01]))).toThrow(); // truncated
  });
});

describe("SMTP", () => {
  it("builds a message that can't be injected into and that is dot-safe", () => {
    const m = buildMessage("ASafariM <no-reply@asafarim.site>", { to: "a@b.c", subject: "Hi", text: ".hi" });
    expect(m).toContain("From: ASafariM <no-reply@asafarim.site>\r\nTo: <a@b.c>\r\nSubject: Hi");
    expect(m.split("\r\n").some((l) => l.startsWith("."))).toBe(false);
    expect(() => buildMessage("x@y.z", { to: "a@b.c\r\nBcc: e@f.g", subject: "s", text: "t" })).toThrow(MailError);
    expect(addressOf("ASafariM <no-reply@asafarim.site>")).toBe("no-reply@asafarim.site");
  });

  /** A tiny SMTP server on loopback that records the conversation. */
  async function fakeServer(script: { ehlo: string[] }) {
    const seen: string[] = [];
    const server = createServer((socket: Socket) => {
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
              socket.write("250 queued\r\n");
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
    return { seen, server, port: (server.address() as { port: number }).port };
  }

  it("delivers over a plain loopback connection (development) without AUTH", async () => {
    const f = await fakeServer({ ehlo: ["fake", "8BITMIME"] });
    try {
      await new SmtpMailer({
        host: "127.0.0.1",
        port: f.port,
        security: "none",
        from: "ASafariM <no-reply@asafarim.site>",
        heloName: "id.test",
      }).send({ to: "a@example.test", subject: "Code", text: "Your code is 123456." });
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

  it("refuses to go on when STARTTLS is required but not offered, and never sends a password in clear", async () => {
    const f = await fakeServer({ ehlo: ["fake", "AUTH PLAIN"] });
    try {
      let error: unknown;
      try {
        await new SmtpMailer({
          host: "127.0.0.1",
          port: f.port,
          security: "starttls",
          user: "u",
          password: "secret-password",
          from: "x@y.z",
          heloName: "id.test",
        }).send({ to: "a@example.test", subject: "s", text: "t" });
      } catch (e) {
        error = e;
      }
      expect((error as MailError).reason).toBe("starttls_unavailable");
      expect(f.seen.some((l) => l.startsWith("AUTH"))).toBe(false);
    } finally {
      f.server.close();
    }
  });
});

describe("local sign-in config", () => {
  const base = {
    IDENTITY_DATABASE_URL: "postgres://identity@db/identity",
    IDENTITY_OTP_SECRET: "o".repeat(40),
    IDENTITY_SMTP_HOST: "smtp.example.test",
    IDENTITY_SMTP_USER: "no-reply@asafarim.site",
    IDENTITY_SMTP_PASSWORD: "pw",
    IDENTITY_SMTP_FROM: "ASafariM <no-reply@asafarim.site>",
  };

  it("defaults to email codes and passkeys over implicit TLS, with no SMS", () => {
    const c = parseLocalLogin(base, { local: false });
    expect(c).toMatchObject({ method: "local", passkeys: true, sms: null, homeUrl: "https://asafarim.site/" });
    expect(c.email).toMatchObject({ dailyLimit: 500, mailer: { kind: "smtp", smtp: { port: 465, security: "tls" } } });
    expect(parseLocalLogin({ ...base, IDENTITY_SMTP_PORT: "587" }, { local: false }).email).toMatchObject({
      mailer: { smtp: { security: "starttls" } },
    });
  });

  it("keeps the first version's IDENTITY_LOGIN_METHOD=sms meaning SMS only", () => {
    const c = parseLocalLogin(
      {
        ...base,
        IDENTITY_LOGIN_METHOD: "sms",
        IDENTITY_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
        IDENTITY_TWILIO_AUTH_TOKEN: "t",
        IDENTITY_TWILIO_FROM: "x",
      },
      { local: false },
    );
    expect(c).toMatchObject({ email: null, passkeys: false, sms: { allowedPrefixes: ["+32"] } });
  });

  it("takes the bootstrap admin's email and phone, normalized", () => {
    const c = parseLocalLogin(
      {
        ...base,
        IDENTITY_BOOTSTRAP_ADMIN_EMAIL: " Ali@Example.test",
        IDENTITY_BOOTSTRAP_ADMIN_PHONE: "+32 470 12 34 56",
      },
      { local: false },
    );
    expect(c.bootstrapAdmin).toEqual([
      { method: "email", identifier: "ali@example.test" },
      { method: "phone", identifier: "+32470123456" },
    ]);
  });

  it("refuses bad settings", () => {
    const bad = (over: Record<string, string | undefined>) => () =>
      parseLocalLogin({ ...base, ...over }, { local: false });
    expect(bad({ IDENTITY_OTP_SECRET: "short" })).toThrow(/at least 32/);
    expect(bad({ IDENTITY_SIGN_IN_METHODS: "passkey" })).toThrow(/needs email or sms/);
    expect(bad({ IDENTITY_SIGN_IN_METHODS: "email,fax" })).toThrow(ConfigError);
    expect(bad({ IDENTITY_SMTP_SECURITY: "none" })).toThrow(/loopback/);
    expect(bad({ IDENTITY_SMTP_PASSWORD: undefined })).toThrow(/both or neither/);
    expect(bad({ IDENTITY_SMTP_FROM: "nobody" })).toThrow(/IDENTITY_SMTP_FROM/);
    expect(bad({ IDENTITY_HOME_URL: "http://asafarim.site/" })).toThrow(/https/);
    expect(bad({ IDENTITY_EMAIL_PROVIDER: "dev-log" })).toThrow(/development/);
  });
});

describe("pages", () => {
  it("escape what the person typed and carry the CSRF token", () => {
    const html = loginPage({
      csrf: "c<s>rf",
      email: true,
      sms: false,
      passkey: false,
      value: '"><script>alert(1)</script>@x',
      error: "<b>",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("passkey.js");
    expect(html).toContain('value="c&lt;s&gt;rf"');
    expect(codePage({ csrf: "x", masked: "a•••i@example.com", via: "email" })).toContain("an email");
  });

  it("the admin page lists requests and connections with a CSRF token on every form", () => {
    const html = adminPage({
      csrf: "tok",
      me: "11111111-1111-1111-1111-111111111111",
      requests: [
        { id: "22222222-2222-2222-2222-222222222222", principalId: "p", label: "a@b.c", createdAt: new Date(0) },
      ],
      connections: [
        {
          principalId: "11111111-1111-1111-1111-111111111111",
          label: "ali@example.test",
          status: "active",
          isAdmin: true,
          grantedAt: new Date(0),
          revokedAt: null,
          lastLoginAt: null,
        },
      ],
      audit: [],
    });
    expect(html).toContain("/admin/requests/22222222-2222-2222-2222-222222222222/approve");
    expect(html.match(/name="csrf" value="tok"/g)!.length).toBe(html.match(/<form /g)!.length);
    expect(html).not.toContain("11111111-1111-1111-1111-111111111111/revoke");
    expect(html).toContain('<a href="/admin" aria-current="page">Connections</a>');
  });

  it("every page has the header (brand to the OS home), the favicon and the footer: no dead ends", () => {
    setHomeUrl("https://home.example.test/");
    try {
      for (const html of [
        page("T", "<h1>T</h1>"),
        loginPage({ csrf: "x", email: true, sms: false, passkey: false }),
        errorPage({ message: "m", code: "c" }),
        loggedOutPage(),
      ]) {
        expect(html).toContain('<a class="brand" href="https://home.example.test/">');
        expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
        expect(html).toMatch(/<footer class="foot">[\s\S]*home\.example\.test<\/a>/);
        expect(html).toContain('<a href="https://home.example.test/">Home</a>');
      }
      expect(errorPage({ message: "m" })).toContain('class="button" href="https://home.example.test/"');
      expect(loggedOutPage()).toContain('class="button" href="https://home.example.test/"');
    } finally {
      setHomeUrl("https://asafarim.site/");
    }
    // The favicon is an image of this origin's own, which the pages' CSP must let load.
    expect(PAGE_CSP).toContain("img-src 'self'");
    expect(FAVICON_SVG).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it("the account page says where to go next: the OS home, then the named apps", () => {
    const html = accountPage({
      csrf: "tok",
      apps: [{ name: "Docs <x>", href: "https://docs.example.test/" }],
      accountId: "11111111-1111-1111-1111-111111111111",
      label: "ali@example.test",
      connected: true,
      isAdmin: false,
      passkeys: [],
    });
    expect(html).toContain("<h2>Where to next</h2>");
    expect(html).toContain('<a class="tile" href="https://asafarim.site/">');
    expect(html).toContain('<a class="tile" href="https://docs.example.test/">');
    expect(html).toContain("<strong>Docs &lt;x&gt;</strong><small>docs.example.test</small>");
    expect(html).toContain("an admin has given your account access");
    expect(html).toContain('<a href="/account" aria-current="page">Account</a>');
    expect(html).not.toContain(">Connections</a></li>");
  });

  it("the account page without named apps still offers the OS home, and no access note", () => {
    const html = accountPage({
      csrf: "tok",
      apps: [],
      accountId: "a",
      label: null,
      connected: false,
      isAdmin: false,
      passkeys: [],
    });
    expect(html).toContain('<a class="tile" href="https://asafarim.site/">');
    expect(html).not.toContain("given your account access");
  });
});
