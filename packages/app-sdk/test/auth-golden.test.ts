/**
 * Golden (equivalence) tests for the Auth.js configuration and helpers that Notes, Docs, Flow and the Admin console use
 * (#344, S2). `__golden__/auth.json` was captured from the implementation that lived in `src/auth.ts` BEFORE it moved to
 * `@asafarim/auth-runtime/authjs`; this test proves the re-exported implementation produces the same output for each
 * consumer's real options and for a table of inputs. It is a unit test of configuration and helper output: it does not
 * log anyone in and says nothing about browser-level behaviour.
 *
 * Regenerate only to record an intended change: `UPDATE_GOLDEN=1 pnpm --filter @asafarim/app-sdk test`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/index.ts";
import {
  asafarimAuthConfig,
  endSessionUrl,
  forwardedOrigin,
  IDENTITY_SESSION_SECONDS,
  SESSION_COOKIE_NAME,
  visitorOrigin,
  withForwardedOrigin,
} from "../src/index.ts";

const GOLDEN = fileURLToPath(new URL("./__golden__/auth.json", import.meta.url));
const NOW = new Date("2026-10-19T10:00:00Z");
const now = Math.floor(NOW.getTime() / 1000);

/** Each consumer's real call (apps/notes, apps/docs, apps/flow lib/auth.ts; core/admin/lib/auth.ts). */
const CONSUMERS = {
  notes: { issuer: "http://localhost:4010", clientId: "notes", secret: "s" },
  docs: { issuer: "http://localhost:4010", clientId: "docs", secret: "s" },
  flow: { issuer: "https://id.asafarim.site/", clientId: "flow", clientSecret: "x".repeat(32), secret: "s" },
  admin: {
    issuer: "http://localhost:4010",
    clientId: "core-admin",
    secret: "s",
    keepIdToken: true,
    sessionMaxAgeSeconds: 3600,
  },
} as const;

type Cfg = ReturnType<typeof asafarimAuthConfig>;
const jwtOf = (cfg: Cfg) => cfg.callbacks.jwt as (a: object) => Record<string, unknown> | null;
const sessionOf = (cfg: Cfg) => cfg.callbacks.session as (a: object) => unknown;

const TOKENS: Record<string, Record<string, unknown>> = {
  empty: {},
  stamped: { sub: "u1", signedInAt: now },
  "stamped just inside the default limit": { sub: "u1", signedInAt: now - (IDENTITY_SESSION_SECONDS - 1) },
  "stamped exactly at the default limit": { sub: "u1", signedInAt: now - IDENTITY_SESSION_SECONDS },
  "stamped just inside 3600": { sub: "u1", signedInAt: now - 3599 },
  "stamped exactly at 3600": { sub: "u1", signedInAt: now - 3600 },
  "with an id token": { sub: "u1", idToken: "a.b.c", signedInAt: now },
  "stamp is a string": { sub: "u1", signedInAt: String(now) },
};
const ARGS: Record<string, object> = {
  "no account": {},
  "sign-in, roles array": {
    profile: { sub: "p-1", roles: ["member", "docs.editor"] },
    account: { id_token: "h.p.s" },
  },
  "sign-in, roles not an array": { profile: { sub: "p-1", roles: "member" }, account: { id_token: "h.p.s" } },
  "sign-in, numeric sub": { profile: { sub: 42 }, account: { id_token: "h.p.s" } },
  "sign-in, no id token": { profile: { sub: "p-1" }, account: {} },
  "sign-in, null id token": { profile: { sub: "p-1" }, account: { id_token: null } },
  "sign-in, no profile": { account: { id_token: "h.p.s" } },
  "later request with a profile but no account": { profile: { sub: "p-2", roles: ["x"] } },
};

const FWD: Record<string, { url: string; method?: string; headers: Record<string, string> }> = {
  "no forwarded host": { url: "http://localhost:4100/api/auth/callback/asafarim?code=1", headers: {} },
  "https gateway": {
    url: "http://localhost:4100/api/auth/callback/asafarim?code=1&state=2",
    headers: { "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https" },
  },
  "host with a port": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": "notes.localhost:8080", "x-forwarded-proto": "http" },
  },
  "list of hosts: first one wins": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": "docs.asafarim.site, evil.example", "x-forwarded-proto": "https, http" },
  },
  "host with a path is ignored": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": "evil.example/x", "x-forwarded-proto": "https" },
  },
  "host with userinfo is ignored": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": "a@evil.example", "x-forwarded-proto": "https" },
  },
  "host with a space is ignored": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": "evil example", "x-forwarded-proto": "https" },
  },
  "host with a leading dot is ignored": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": ".evil.example", "x-forwarded-proto": "https" },
  },
  "unknown protocol keeps the app's own": {
    url: "http://localhost:4100/x",
    headers: { "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "javascript" },
  },
  "host only": { url: "http://localhost:4100/x", headers: { "x-forwarded-host": "docs.asafarim.site" } },
  "same as the request's own": {
    url: "https://docs.asafarim.site/x",
    headers: { "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https" },
  },
  "post keeps its method": {
    url: "http://localhost:4100/api/auth/signin",
    method: "POST",
    headers: { "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https" },
  },
};

const VISITOR: Record<string, Record<string, string>> = {
  gateway: { host: "localhost:4100", "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https" },
  "host only": { host: "docs.asafarim.site" },
  "localhost subdomain": { host: "notes.localhost:8080" },
  localhost: { host: "localhost:4100" },
  "127.0.0.1": { host: "127.0.0.1:4100" },
  "bad forwarded host falls back to Host": { host: "docs.asafarim.site", "x-forwarded-host": "evil.example/x" },
  "bad Host": { host: "evil.example/x" },
  "forwarded proto http, public host": {
    host: "x",
    "x-forwarded-host": "docs.asafarim.site",
    "x-forwarded-proto": "http",
  },
  "forwarded proto garbage": { host: "docs.asafarim.site", "x-forwarded-proto": "gopher" },
  list: { host: "x", "x-forwarded-host": "docs.asafarim.site, other.example", "x-forwarded-proto": "https, http" },
  none: {},
};

const END_SESSION = {
  "trailing slash on the issuer": {
    issuer: "https://id.asafarim.site/",
    clientId: "docs",
    postLogoutRedirectUri: "https://docs.asafarim.site/",
  },
  "no return address": { issuer: "http://localhost:4010", clientId: "notes", postLogoutRedirectUri: null },
  "undefined return address": { issuer: "http://localhost:4010", clientId: "notes" },
  "empty return address": { issuer: "http://localhost:4010", clientId: "notes", postLogoutRedirectUri: "" },
  "characters that need escaping": {
    issuer: "http://localhost:4010",
    clientId: "a b&c",
    postLogoutRedirectUri: "http://x/?a=1&b=2",
  },
};

/** Everything the golden file records, computed from the code under test. */
function capture() {
  const configs: Record<string, unknown> = {};
  const callbacks: Record<string, unknown> = {};
  for (const [name, opts] of Object.entries(CONSUMERS)) {
    const cfg = asafarimAuthConfig(opts);
    // JSON drops functions; record their presence and arity separately.
    configs[name] = {
      json: JSON.parse(JSON.stringify(cfg)),
      callbackKinds: Object.fromEntries(Object.entries(cfg.callbacks).map(([k, v]) => [k, typeof v])),
      topLevelKeys: Object.keys(cfg).sort(),
    };
    const jwt: Record<string, unknown> = {};
    for (const [tName, token] of Object.entries(TOKENS)) {
      for (const [aName, args] of Object.entries(ARGS)) {
        jwt[`${tName} | ${aName}`] = jwtOf(cfg)({ token: structuredClone(token), ...structuredClone(args) });
      }
    }
    const session: Record<string, unknown> = {};
    for (const [tName, token] of Object.entries({
      "sub and id token": { sub: "u1", idToken: "a.b.c" },
      "numeric sub": { sub: 7 },
      "no sub": {},
    })) {
      session[`${tName} | user`] = sessionOf(cfg)({ session: { user: { name: "n" } }, token });
      session[`${tName} | no user`] = sessionOf(cfg)({ session: {}, token });
      session[`${tName} | null user`] = sessionOf(cfg)({ session: { user: null }, token });
    }
    callbacks[name] = { jwt, session };
  }

  const forwarded: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(FWD)) {
    const hasBody = f.method === "POST";
    const req = new Request(f.url, {
      method: f.method ?? "GET",
      headers: f.headers,
      ...(hasBody ? { body: "a=1" } : {}),
    });
    const out = withForwardedOrigin(req);
    forwarded[name] = {
      url: out.url,
      method: out.method,
      sameInstance: out === req,
      forwardedHeaderKept: out.headers.get("x-forwarded-host"),
    };
  }

  const visitor: Record<string, unknown> = {};
  for (const [name, h] of Object.entries(VISITOR)) visitor[name] = visitorOrigin(new Headers(h));
  visitor["plain object with get()"] = visitorOrigin({
    get: (k: string) => (k === "host" ? "docs.asafarim.site" : null),
  });

  const endSession: Record<string, unknown> = {};
  for (const [name, o] of Object.entries(END_SESSION)) endSession[name] = endSessionUrl(o);

  return {
    constants: { SESSION_COOKIE_NAME, IDENTITY_SESSION_SECONDS },
    exports: Object.keys(sdk).sort(),
    configs,
    callbacks,
    forwarded,
    visitor,
    endSession,
  };
}

describe("auth golden fixtures (captured from the pre-move implementation)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("the Auth.js config and helpers produce exactly the recorded output for Notes, Docs, Flow and the Admin console", () => {
    const actual = JSON.parse(JSON.stringify(capture()));
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(actual).toEqual(golden);
  });

  it("the golden file really covers each consumer and a meaningful number of vectors", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as ReturnType<typeof capture>;
    expect(Object.keys(golden.configs).sort()).toEqual(["admin", "docs", "flow", "notes"]);
    expect(Object.keys((golden.callbacks as Record<string, { jwt: object }>).admin!.jwt).length).toBeGreaterThanOrEqual(
      60,
    );
    expect(Object.keys(golden.forwarded).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(golden.visitor).length).toBeGreaterThanOrEqual(10);
  });

  it("forwardedOrigin wraps a handler so it sees the visitor's origin", () => {
    const seen: string[] = [];
    const wrapped = forwardedOrigin((r: Request) => {
      seen.push(r.url);
      return 1;
    });
    wrapped(
      new Request("http://localhost:4100/a", {
        headers: { "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https" },
      }),
    );
    wrapped(new Request("http://localhost:4100/b"));
    expect(seen).toEqual(["https://docs.asafarim.site/a", "http://localhost:4100/b"]);
  });
});
