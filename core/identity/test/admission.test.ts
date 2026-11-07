import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { type AdmissionSubject, currentAdmissions, decide } from "../src/admission.ts";
import { ClientConfigError, admissionPolicies, loadClients } from "../src/clients.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createProvider } from "../src/provider.ts";
import { createLogger } from "../src/log.ts";

const none: AdmissionSubject = { suspended: false, globalActive: false, admittedClients: [] };
const subject = (over: Partial<AdmissionSubject>): AdmissionSubject => ({ ...none, ...over });

describe("decide: the one access decision", () => {
  // The order is the policy: unknown, suspended, global, this client's admission, then no.
  const table: [string, AdmissionSubject | null, string | null, string][] = [
    ["unknown person", null, "a", "deny:unknown"],
    ["unknown person, unknown client", null, null, "deny:unknown"],
    ["no access at all", none, "a", "deny:no_access"],
    ["suspended", subject({ suspended: true }), "a", "deny:suspended"],
    ["suspended beats a global connection", subject({ suspended: true, globalActive: true }), "a", "deny:suspended"],
    ["suspended beats an admission", subject({ suspended: true, admittedClients: ["a"] }), "a", "deny:suspended"],
    [
      "suspended beats both",
      subject({ suspended: true, globalActive: true, admittedClients: ["a"] }),
      "a",
      "deny:suspended",
    ],
    ["global connection, any client", subject({ globalActive: true }), "a", "allow:connection"],
    ["global connection, client unknown", subject({ globalActive: true }), null, "allow:connection"],
    ["admitted to this client", subject({ admittedClients: ["a"] }), "a", "allow:public_admission"],
    ["admitted to another client only", subject({ admittedClients: ["b"] }), "a", "deny:out_of_scope"],
    ["admitted, client cannot be told", subject({ admittedClients: ["a"] }), null, "deny:out_of_scope"],
    [
      "global and admitted: global wins the label",
      subject({ globalActive: true, admittedClients: ["a"] }),
      "a",
      "allow:connection",
    ],
  ];
  it.each(table)("%s", (_name, s, client, expected) => {
    const d = decide(s, client);
    expect(d.allow ? `allow:${d.via}` : `deny:${d.reason}`).toBe(expected);
  });

  it("an admission only counts while the client's current policy is public", () => {
    const policy = (id: string) => (id === "a" ? "public" : "restricted");
    expect(currentAdmissions(["a", "b"], policy)).toEqual(["a"]);
    // A client switched back to restricted stops honouring what it handed out.
    expect(decide(subject({ admittedClients: currentAdmissions(["b"], policy) }), "b")).toEqual({
      allow: false,
      reason: "no_access",
    });
  });
});

describe("admission policy in the clients file", () => {
  const base = { client_id: "app", primary_domain: "app.example", redirect_uris: ["https://app.example/cb"] };

  it("defaults to restricted, so nothing changes until a client opts in", () => {
    expect(admissionPolicies({ clients: [base] }).get("app")).toBe("restricted");
    expect(admissionPolicies({ clients: [{ ...base, admission: "public" }] }).get("app")).toBe("public");
  });

  it("refuses anything but the two literals, loudly", () => {
    for (const bad of ["banana", "PUBLIC", "", "open", 1, true, null, ["public"]]) {
      expect(() => admissionPolicies({ clients: [{ ...base, admission: bad as never }] }), String(bad)).toThrow(
        ClientConfigError,
      );
    }
  });

  it("is not part of what oidc-provider is told about a client (a browser can never see or set it)", () => {
    const [c] = loadClients({ clients: [{ ...base, admission: "public" }] }, {});
    expect(JSON.stringify(c)).not.toContain("admission");
  });
});

describe("public admission at startup", () => {
  async function env(method: "local" | "hub", admission: string | undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), "identity-config-"));
    const file = path.join(dir, "clients.json");
    writeFileSync(
      file,
      JSON.stringify({
        clients: [
          {
            client_id: "app",
            primary_domain: "localhost",
            redirect_uris: ["http://localhost:3000/cb"],
            ...(admission ? { admission } : {}),
          },
        ],
      }),
    );
    const ec = await generateKeyPair("ES256", { extractable: true });
    const ed1 = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const ed2 = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    return {
      IDENTITY_ISSUER: "http://localhost:3000",
      IDENTITY_COOKIE_KEYS: "k".repeat(40),
      IDENTITY_CLIENTS_FILE: file,
      IDENTITY_REDIS_URL: "redis://localhost:6379",
      IDENTITY_OIDC_JWKS: JSON.stringify({ keys: [{ ...(await exportJWK(ec.privateKey)), kid: "k1" }] }),
      NODE_ENV: "development",
      IDENTITY_LOGIN_METHOD: method,
      IDENTITY_OTP_SECRET: "o".repeat(40),
      IDENTITY_DATABASE_URL: "postgres://x/y",
      IDENTITY_HOME_URL: "http://localhost:3000/",
      IDENTITY_SIGN_IN_METHODS: "email",
      IDENTITY_SMTP_HOST: "smtp.example.test",
      IDENTITY_SMTP_USER: "no-reply@asafarim.site",
      IDENTITY_SMTP_PASSWORD: "pw",
      IDENTITY_SMTP_FROM: "ASafariM <no-reply@asafarim.site>",
      IDENTITY_ACCOUNTS_DATABASE_URL: "postgres://x/y",
      IDENTITY_HUB_CONTINUE_URL: "http://localhost:3001/continue",
      IDENTITY_HANDOFF_PRIVATE_JWK: JSON.stringify(await exportJWK(ed1.privateKey)),
      IDENTITY_HUB_PUBLIC_JWK: JSON.stringify(await exportJWK(ed2.publicKey)),
    };
  }

  it("local mode accepts a public client", async () => {
    const config = await loadConfig(await env("local", "public"));
    expect(config.admission.get("app")).toBe("public");
  });

  it("an unlisted client is restricted", async () => {
    const config = await loadConfig(await env("local", undefined));
    expect(config.admission.get("app")).toBe("restricted");
  });

  it("Hub mode refuses a public client: it has no per-client admission, so it must not look public", async () => {
    await expect(loadConfig(await env("hub", "public"))).rejects.toThrow(ConfigError);
    await expect(loadConfig(await env("hub", "public"))).rejects.toThrow(/needs IDENTITY_LOGIN_METHOD=local/);
    expect((await loadConfig(await env("hub", "restricted"))).admission.get("app")).toBe("restricted");
  });

  it("the provider refuses the same combination even if the config check were bypassed", () => {
    expect(() =>
      createProvider({
        issuer: "http://localhost:3000",
        jwks: { keys: [] },
        cookieKeys: ["k".repeat(40)],
        clients: [],
        admission: new Map([["app", "public"]]),
        trustProxy: false,
        adapter: undefined as never,
        accounts: undefined as never,
        readiness: async () => ({}),
        log: createLogger(() => undefined),
        loginMethod: "hub",
        handoffPrivateKey: {} as never,
        hubPublicKey: {} as never,
        hubContinueUrl: "https://hub.example/continue",
        replay: {} as never,
        pending: {} as never,
      }),
    ).toThrow(/needs the local login method/);
  });
});
