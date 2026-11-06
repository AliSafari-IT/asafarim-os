/**
 * id.asafarim.site in English, Dutch, French and German (src/i18n.ts): the request's language from ?lang=, the
 * shared asafarim-locale cookie or the browser; the language selector on every page; and the code and decision
 * e-mails in the person's language. Driven like sign-in.test.ts, with the provider's locale middleware around it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type Messages, MESSAGES, inLocale, withRequestLocale } from "../src/i18n.ts";
import { createLogger } from "../src/log.ts";
import { errorPage, SELECTOR_JS } from "../src/pages.ts";
import { codeMessage } from "../src/sms.ts";
import { type SignIn, createSignIn } from "../src/sign-in.ts";
import {
  Browser,
  CapturingMailer,
  CapturingSender,
  MemoryChallenges,
  MemoryEphemeral,
  MemoryFlows,
  MemoryLimiter,
  MemorySessions,
  MemoryStore,
  csrfOf,
  request,
} from "./fakes.ts";

const ADMIN = "ali@example.test";
const ISSUER = "https://id.example.test";

describe("identity in four languages", () => {
  let store: MemoryStore;
  let mailer: CapturingMailer;
  let signIn: SignIn;

  beforeEach(async () => {
    store = new MemoryStore();
    mailer = new CapturingMailer();
    await store.bootstrapAdmin([{ method: "email", identifier: ADMIN }]);
    signIn = createSignIn({
      issuer: ISSUER,
      homeUrl: "https://home.example.test/",
      otpSecret: "o".repeat(40),
      email: { mailer, dailyLimit: 100 },
      sms: { sender: new CapturingSender(), allowedPrefixes: ["+32"], dailyLimit: 100 },
      passkeys: { rp: { id: "id.example.test", origin: ISSUER, name: "ASafariM" } },
      apps: [{ id: "docs", name: "Docs", href: "https://docs.example.test/" }],
      ephemeral: new MemoryEphemeral(),
      store,
      challenges: new MemoryChallenges(),
      limits: new MemoryLimiter(),
      sessions: new MemorySessions(),
      flows: new MemoryFlows(),
      endProviderSessions: async () => 0,
      log: createLogger(() => {}),
    });
  });

  /** A browser that keeps the asafarim-locale cookie and sends its Accept-Language, like the real one. */
  class LocaleBrowser extends Browser {
    locale = "";
    readonly acceptLanguage: string;
    constructor(acceptLanguage = "") {
      super();
      this.acceptLanguage = acceptLanguage;
    }
  }

  /** One request through the provider's locale middleware and the sign-in routes. */
  const go = (b: LocaleBrowser, method: "GET" | "POST", url: string, form?: Record<string, string>) => {
    const u = new URL(url, ISSUER);
    let setCookie = "";
    return request(
      (ctx) =>
        withRequestLocale(
          {
            method,
            path: u.pathname,
            querystring: u.search.slice(1),
            get: (f) =>
              f === "cookie"
                ? b.locale && `asafarim-locale=${b.locale}`
                : f === "accept-language"
                  ? b.acceptLanguage
                  : ctx.get(f),
          },
          "id.example.test",
          (cookie) => {
            setCookie = cookie;
            b.locale = /^asafarim-locale=(\w+)/.exec(cookie)![1]!;
          },
          () => signIn.handle(ctx),
        ),
      b,
      method,
      url,
      form,
    ).then((r) => ({ ...r, setCookie }));
  };
  const codeIn = (to: string) => /\b(\d{6})\b/.exec([...mailer.sent].reverse().find((m) => m.to === to)!.text)![1]!;

  it("speaks English by default, the browser's language when it is one of the four, and ?lang= wins", async () => {
    const en = await go(new LocaleBrowser(), "GET", "/login");
    expect(en.body).toContain('<html lang="en">');
    expect(en.body).toContain('<h1 id="signin">Sign in</h1>');
    const de = await go(new LocaleBrowser("de-BE,de;q=0.9,en;q=0.5"), "GET", "/login");
    expect(de.body).toContain('<html lang="de">');
    expect(de.body).toContain('<h1 id="signin">Anmelden</h1>');
    expect(de.setCookie).toBe(""); // a browser's preference is not a choice: nothing is stored
    const fr = await go(new LocaleBrowser("de"), "GET", "/login?lang=fr");
    expect(fr.body).toContain('<html lang="fr">');
    expect(fr.body).toContain('<h1 id="signin">Se connecter</h1>');
  });

  it("remembers a ?lang= choice for every *.asafarim.site host, and the selector keeps the page's query", async () => {
    const b = new LocaleBrowser();
    const page = await go(b, "GET", "/login?uid=abc-1&lang=nl");
    expect(page.setCookie).toBe(
      "asafarim-locale=nl; Path=/; Max-Age=31536000; SameSite=Lax; Secure; Domain=example.test",
    );
    expect(page.body).toContain('<div class="locale-selector" data-locale-selector data-lang="nl">');
    expect(page.body).toContain('<a href="/login?uid=abc-1&amp;lang=fr" hreflang="fr"');
    expect(page.body).toContain('<span aria-current="true" lang="nl">NL</span>');
    expect(page.body).toContain('<script src="/static/selector.js" defer></script>');
    // the next page, without ?lang=, is still Dutch
    expect((await go(b, "GET", "/login")).body).toContain('<html lang="nl">');
    // and the footer links the policies in that language
    expect(page.body).toContain('<a href="https://asafarim.site/nl/privacy">Privacy</a>');
    expect(page.body).toContain('href="https://asafarim.site/nl/terms">voorwaarden</a>');
  });

  it("sends the code in the person's language, and every step of the code page speaks it", async () => {
    const b = new LocaleBrowser();
    const start = await go(b, "GET", "/login?lang=nl");
    const csrf = csrfOf(start.body);
    await go(b, "POST", "/login/start", { csrf, via: "email", identifier: "kim@example.test" });
    const mail = mailer.sent.at(-1)!;
    expect(mail.subject).toMatch(/^Je aanmeldcode voor ASafariM: \d{6}$/);
    expect(mail.text).toContain("De code vervalt na 5 minuten");
    const code = await go(b, "GET", "/login/code");
    expect(code.body).toContain("<h1>Kijk in je mailbox</h1>");
    const wrong = await go(b, "POST", "/login/verify", { csrf, code: "000000" });
    expect(wrong.body).toContain("Die code klopt niet. Kijk de e-mail na en probeer opnieuw.");
    // a POST's page links the selector to its GET page
    expect(wrong.body).toContain('<a href="/login/code?lang=fr" hreflang="fr"');
    expect((await go(b, "POST", "/login/verify", { csrf, code: codeIn("kim@example.test") })).status).toBe(303);
    const ask = await go(b, "GET", "/login");
    expect(ask.body).toContain("<h1>Toegang vragen</h1>");
    expect(ask.body).toContain("Welke apps heb je nodig?");
  });

  it("tells the decision in the language the person asked in, whatever the admin's", async () => {
    const asker = new LocaleBrowser();
    const start = await go(asker, "GET", "/login?lang=fr");
    const csrf = csrfOf(start.body);
    await go(asker, "POST", "/login/start", { csrf, via: "email", identifier: "lea@example.test" });
    await go(asker, "POST", "/login/verify", { csrf, code: codeIn("lea@example.test") });
    const form = await go(asker, "GET", "/login");
    const sent = await go(asker, "POST", "/login/request", { csrf: csrfOf(form.body), app: "docs", note: "Bonjour" });
    expect(sent.body).toContain("<h1>Demande en attente</h1>");
    expect(sent.body).toContain("Votre demande a été envoyée.");
    const [request] = await store.pendingRequests();
    expect(request!.locale).toBe("fr");

    const admin = new LocaleBrowser("en-GB");
    const a = await go(admin, "GET", "/login");
    const ac = csrfOf(a.body);
    await go(admin, "POST", "/login/start", { csrf: ac, via: "email", identifier: ADMIN });
    await go(admin, "POST", "/login/verify", { csrf: ac, code: codeIn(ADMIN) });
    const panel = await go(admin, "GET", "/admin");
    expect(panel.body).toContain("<h1>Connections</h1>");
    await go(admin, "POST", `/admin/requests/${request!.id}/approve`, { csrf: csrfOf(panel.body) });
    const mail = mailer.sent.find((m) => m.to === "lea@example.test" && m.subject.includes("approuvée"))!;
    expect(mail.subject).toBe("ASafariM : votre demande d’accès a été approuvée");
    expect(mail.text).toContain("Bonne nouvelle : un administrateur a approuvé votre demande d’accès pour Docs.");
    const done = await go(admin, "GET", "/admin?done=approved&lang=de");
    expect(done.body).toContain("Anfrage genehmigt");
  });

  it("errors, the SMS and the passkey script's words follow the language too", () => {
    expect(inLocale("de", () => errorPage({ message: "x" }))).toContain(
      "<h1>Die Anmeldung wurde nicht abgeschlossen</h1>",
    );
    expect(inLocale("fr", () => codeMessage("123456", "id.example.test", 5))).toBe(
      "Votre code de connexion ASafariM est 123456. Il expire dans 5 minutes. Ne le communiquez à personne.\n\n@id.example.test #123456",
    );
    // English stays exactly as before, outside a request too
    expect(codeMessage("123456", "id.asafarim.site", 5)).toBe(
      "Your ASafariM sign-in code is 123456. It expires in 5 minutes. Never share it with anyone.\n\n@id.asafarim.site #123456",
    );
    expect(SELECTOR_JS).toContain("@asafarim/country-language-selector");
  });

  it("every language has every message, none empty", () => {
    const shape = (value: unknown, path = ""): string[] =>
      typeof value === "function"
        ? [`${path}()`]
        : Array.isArray(value)
          ? value.flatMap((v, i) => shape(v, `${path}[${i}]`))
          : value && typeof value === "object"
            ? Object.entries(value).flatMap(([k, v]) => shape(v, `${path}.${k}`))
            : [path];
    const english = shape(MESSAGES.en).sort();
    for (const [locale, m] of Object.entries(MESSAGES) as [string, Messages][]) {
      expect(shape(m).sort(), locale).toEqual(english);
      const strings = JSON.stringify(m, (_k, v: unknown) => (typeof v === "function" ? undefined : v));
      expect(strings, locale).not.toContain('""');
    }
  });
});
