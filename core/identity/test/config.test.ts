import { describe, expect, it } from "vitest";
import { accountFromRow } from "../src/accounts.ts";
import { ClientConfigError, loadClients } from "../src/clients.ts";
import { ConfigError, isLoopbackHost, parseSigningJwks, refuseLoopbackOutsideDevelopment } from "../src/config.ts";
import { createLogger, safe } from "../src/log.ts";

const SECRET = "s".repeat(40);

describe("client config", () => {
  const base = { client_id: "testora", primary_domain: "testora.cloud", redirect_uris: ["https://testora.cloud/cb"] };

  it("produces a code-flow, ES256 client; confidential when a secret env is named", () => {
    const [c] = loadClients({ clients: [{ ...base, client_secret_env: "S" }] }, { S: SECRET });
    expect(c).toMatchObject({
      client_id: "testora",
      client_secret: SECRET,
      token_endpoint_auth_method: "client_secret_basic",
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      id_token_signed_response_alg: "ES256",
    });
    const [pub] = loadClients({ clients: [base] }, {});
    expect(pub!.token_endpoint_auth_method).toBe("none");
    expect(pub).not.toHaveProperty("client_secret");
  });

  it("refuses URIs off the primary domain, non-https, or with a fragment", () => {
    const bad = (over: object) => () => loadClients({ clients: [{ ...base, ...over }] }, {});
    expect(bad({ redirect_uris: ["https://evil.example/cb"] })).toThrow(ClientConfigError);
    expect(bad({ redirect_uris: ["https://sub.testora.cloud/cb"] })).toThrow(/primary domain/);
    expect(bad({ redirect_uris: ["http://testora.cloud/cb"] })).toThrow(/https/);
    expect(bad({ redirect_uris: ["https://testora.cloud/cb#x"] })).toThrow(/fragment/);
    expect(bad({ post_logout_redirect_uris: ["https://asafarim.com/"] })).toThrow(/primary domain/);
    expect(bad({ backchannel_logout_uri: "https://asafarim.com/bcl" })).toThrow(/primary domain/);
  });

  it("refuses a missing or short secret, duplicate ids and bad ids", () => {
    expect(() => loadClients({ clients: [{ ...base, client_secret_env: "S" }] }, {})).toThrow(/S must be set/);
    expect(() => loadClients({ clients: [{ ...base, client_secret_env: "S" }] }, { S: "short" })).toThrow(/32/);
    expect(() => loadClients({ clients: [base, base] }, {})).toThrow(/duplicate/);
    expect(() => loadClients({ clients: [{ ...base, client_id: "Bad_Id" }] }, {})).toThrow(/invalid client_id/);
  });

  it("allows http://localhost only when asked (local development)", () => {
    const local = { ...base, redirect_uris: ["http://localhost:4000/cb"] };
    expect(() => loadClients({ clients: [local] }, {})).toThrow();
    expect(loadClients({ clients: [local] }, {}, { allowLocalhost: true })).toHaveLength(1);
  });
});

describe("signing keys", () => {
  const key = (kid: string) => ({ kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid });

  it("accepts one key, or two during rotation, and pins ES256", () => {
    expect(parseSigningJwks({ IDENTITY_OIDC_JWKS: JSON.stringify({ keys: [key("a")] }) }).keys[0]).toMatchObject({
      alg: "ES256",
      use: "sig",
    });
    expect(parseSigningJwks({ IDENTITY_OIDC_JWKS: JSON.stringify({ keys: [key("a"), key("b")] }) }).keys).toHaveLength(
      2,
    );
  });

  it("refuses zero or three keys, public keys, other curves and duplicate kids", () => {
    const parse = (keys: object[]) => () => parseSigningJwks({ IDENTITY_OIDC_JWKS: JSON.stringify({ keys }) });
    expect(parse([])).toThrow(ConfigError);
    expect(parse([key("a"), key("b"), key("c")])).toThrow(/1 or 2/);
    expect(parse([{ ...key("a"), d: undefined }])).toThrow(/private EC P-256/);
    expect(parse([{ ...key("a"), crv: "P-384" }])).toThrow(/P-256/);
    expect(parse([key("a"), key("a")])).toThrow(/duplicate kid/);
    expect(() => parseSigningJwks({})).toThrow(/IDENTITY_OIDC_JWKS is not set/);
  });
});

describe("accounts view mapping", () => {
  it("maps identity_accounts_v columns to claims; only isActive === true is active", () => {
    expect(
      accountFromRow({
        id: "u1",
        email: "a@b.c",
        name: "A",
        image: "https://x/p.png",
        isActive: true,
        roles: ["admin"],
      }),
    ).toEqual({
      sub: "u1",
      email: "a@b.c",
      name: "A",
      picture: "https://x/p.png",
      roles: ["admin"],
      isActive: true,
    });
    expect(accountFromRow({ id: "u2", isActive: "true", roles: null })).toMatchObject({ isActive: false, roles: [] });
  });
});

describe("logging", () => {
  it("drops fields that look like tokens, codes or personal data", () => {
    expect(
      safe({
        uid: "u",
        clientId: "c",
        errorCode: "x",
        access_token: "t",
        code: "c",
        email: "e",
        assertion: "a",
        count: 1,
      }),
    ).toEqual({
      uid: "u",
      clientId: "c",
      errorCode: "x",
      count: 1,
    });
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).info("m", { id_token: "secret", uid: "u" });
    expect(lines[0]).not.toContain("secret");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", service: "identity", msg: "m", uid: "u" });
  });
});

describe("loopback hand-off targets only with NODE_ENV=development (OS-D1 review)", () => {
  const dev = {
    IDENTITY_HUB_CONTINUE_URL: "http://localhost:4000/oidc/continue",
    IDENTITY_ISSUER: "http://localhost:4010",
  };

  it("refuses a dev env file in production: loopback continue URL or issuer", () => {
    expect(() => refuseLoopbackOutsideDevelopment({ NODE_ENV: "production" }, dev)).toThrow(
      /IDENTITY_HUB_CONTINUE_URL points at a loopback host/,
    );
    expect(() =>
      refuseLoopbackOutsideDevelopment(
        { NODE_ENV: "production" },
        { ...dev, IDENTITY_HUB_CONTINUE_URL: "https://hub.asafarim.com/oidc/continue" },
      ),
    ).toThrow(/IDENTITY_ISSUER/);
  });

  it("refuses loopback for any NODE_ENV that isn't exactly development: unset, a typo, test", () => {
    for (const NODE_ENV of [undefined, "", "prod", "Development", "test"]) {
      expect(() => refuseLoopbackOutsideDevelopment({ NODE_ENV }, dev), String(NODE_ENV)).toThrow(
        /only allowed with NODE_ENV=development/,
      );
    }
  });

  it("allows the production hosts, and allows loopback in development", () => {
    expect(() =>
      refuseLoopbackOutsideDevelopment(
        { NODE_ENV: "production" },
        {
          IDENTITY_HUB_CONTINUE_URL: "https://hub.asafarim.com/oidc/continue",
          IDENTITY_ISSUER: "https://id.asafarim.site",
        },
      ),
    ).not.toThrow();
    expect(() => refuseLoopbackOutsideDevelopment({ NODE_ENV: "development" }, dev)).not.toThrow();
  });

  it("recognises every loopback form", () => {
    for (const h of ["localhost", "LOCALHOST", "dev.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1", "0.0.0.0"])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["hub.asafarim.com", "localhost.evil.example", "10.0.0.1", "128.0.0.1"])
      expect(isLoopbackHost(h)).toBe(false);
  });
});
