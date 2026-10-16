import { describe, expect, it } from "vitest";
import { ConfigError, parseSmsLogin } from "../src/config.ts";
import { blindHandle, generateCode, hashCode, isCodeShaped } from "../src/otp.ts";
import { maskPhone, normalizePhone, parsePrefixes, prefixAllowed } from "../src/phone.ts";
import { DevLogSmsSender, SmsError, TwilioSmsSender, codeMessage } from "../src/sms.ts";
import { adminPage, codePage, phonePage } from "../src/sms-pages.ts";

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

describe("SMS login config", () => {
  const base = {
    IDENTITY_DATABASE_URL: "postgres://identity@db/identity",
    IDENTITY_OTP_SECRET: "o".repeat(40),
    IDENTITY_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    IDENTITY_TWILIO_AUTH_TOKEN: "token",
    IDENTITY_TWILIO_FROM: "ASafariM",
  };

  it("defaults to Twilio, Belgian numbers, 200 SMS a day and the landing page", () => {
    const c = parseSmsLogin(base, { local: false });
    expect(c).toMatchObject({
      method: "sms",
      allowedPrefixes: ["+32"],
      dailySmsLimit: 200,
      homeUrl: "https://asafarim.site/",
      bootstrapAdminPhone: null,
      sender: { provider: "twilio" },
    });
  });

  it("normalizes the bootstrap admin's number and refuses a bad one", () => {
    expect(
      parseSmsLogin({ ...base, IDENTITY_BOOTSTRAP_ADMIN_PHONE: "+32 470 12 34 56" }, { local: false })
        .bootstrapAdminPhone,
    ).toBe("+32470123456");
    expect(() => parseSmsLogin({ ...base, IDENTITY_BOOTSTRAP_ADMIN_PHONE: "0470123456" }, { local: false })).toThrow(
      ConfigError,
    );
  });

  it("refuses a short OTP secret, a non-https home, bad prefixes and a missing Twilio setting", () => {
    const bad = (over: Record<string, string | undefined>) => () =>
      parseSmsLogin({ ...base, ...over }, { local: false });
    expect(bad({ IDENTITY_OTP_SECRET: "short" })).toThrow(/at least 32/);
    expect(bad({ IDENTITY_HOME_URL: "http://asafarim.site/" })).toThrow(/https/);
    expect(bad({ IDENTITY_SMS_ALLOWED_PREFIXES: "32" })).toThrow(/prefixes/i);
    expect(bad({ IDENTITY_TWILIO_AUTH_TOKEN: undefined })).toThrow(/IDENTITY_TWILIO_AUTH_TOKEN/);
    expect(bad({ IDENTITY_SMS_DAILY_LIMIT: "0" })).toThrow(/IDENTITY_SMS_DAILY_LIMIT/);
    expect(bad({ IDENTITY_SMS_PROVIDER: "carrier-pigeon" })).toThrow(/twilio or dev-log/);
  });

  it("allows the dev log sender only in development on localhost", () => {
    const dev = { ...base, IDENTITY_SMS_PROVIDER: "dev-log" };
    expect(() => parseSmsLogin(dev, { local: true })).toThrow(/development/);
    expect(() => parseSmsLogin({ ...dev, NODE_ENV: "development" }, { local: false })).toThrow(/development/);
    expect(parseSmsLogin({ ...dev, NODE_ENV: "development" }, { local: true }).sender).toEqual({
      provider: "dev-log",
    });
  });
});

describe("pages", () => {
  it("escape what the person typed and carry the CSRF token", () => {
    const html = phonePage({ csrf: "c<s>rf", value: '"><script>alert(1)</script>', error: "<b>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('value="c&lt;s&gt;rf"');
    expect(html).toContain("&lt;b&gt;");
    expect(codePage({ csrf: "x", phone: "+32470123456" })).toContain("+32 ••• ••• 56");
    expect(codePage({ csrf: "x", phone: "+32470123456" })).not.toContain("470123456");
  });

  it("the admin page lists requests and connections with a CSRF token on every form", () => {
    const html = adminPage({
      csrf: "tok",
      me: "11111111-1111-1111-1111-111111111111",
      requests: [
        { id: "22222222-2222-2222-2222-222222222222", principalId: "p", phone: "+32470000002", createdAt: new Date(0) },
      ],
      connections: [
        {
          principalId: "11111111-1111-1111-1111-111111111111",
          phone: "+32470000001",
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
    const forms = html.match(/<form /g)!.length;
    expect(html.match(/name="csrf" value="tok"/g)!.length).toBe(forms);
    // No revoke button for yourself.
    expect(html).not.toContain("11111111-1111-1111-1111-111111111111/revoke");
  });
});
