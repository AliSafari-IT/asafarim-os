/**
 * Environment for the identity service. Every secret comes from env (the
 * deployment's encrypted env file); nothing secret is read from disk except the
 * client config, which names env vars for client secrets instead of holding them.
 */
import { readFileSync } from "node:fs";
import { importJWK, type CryptoKey, type JWK, type KeyObject } from "jose";
import { loadClients, type ClientConfigFile, type OidcClient } from "./clients.ts";
import { isE164, normalizePhone, parsePrefixes } from "./phone.ts";
import type { TwilioConfig } from "./sms.ts";

/** IDENTITY_LOGIN_METHOD=hub (the default): login delegated to Hub (ADR 0002, Addendum A). */
export interface HubLoginConfig {
  method: "hub";
  accountsDatabaseUrl: string;
  handoffPrivateKey: CryptoKey | KeyObject;
  hubPublicKey: CryptoKey | KeyObject;
  hubContinueUrl: string;
}

/** IDENTITY_LOGIN_METHOD=sms: the service's own SMS sign-in, connections in its own database. */
export interface SmsLoginConfig {
  method: "sms";
  databaseUrl: string;
  otpSecret: string;
  allowedPrefixes: string[];
  dailySmsLimit: number;
  homeUrl: string;
  /** The first admin's number (E.164), connected only while no admin is. Null when unset. */
  bootstrapAdminPhone: string | null;
  sender: { provider: "twilio"; twilio: TwilioConfig } | { provider: "dev-log" };
}

export interface IdentityConfig {
  issuer: string;
  port: number;
  redisUrl: string;
  /** Private OIDC signing keys (EC P-256, ES256). The first one signs; the rest stay in JWKS for rotation. */
  jwks: { keys: JWK[] };
  cookieKeys: string[];
  clients: OidcClient[];
  trustProxy: boolean;
  login: HubLoginConfig | SmsLoginConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`${name} is not set`);
  return v;
}

function parseJson<T>(env: Env, name: string): T {
  try {
    return JSON.parse(required(env, name)) as T;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${name} is not valid JSON`);
  }
}

/** An Ed25519 JWK; the private one must carry `d`, the public one must not. */
async function ed25519(env: Env, name: string, kind: "private" | "public") {
  const jwk = parseJson<JWK>(env, name);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new ConfigError(`${name} must be an Ed25519 (OKP) JWK`);
  if (kind === "private" && !jwk.d) throw new ConfigError(`${name} must be a private key`);
  if (kind === "public" && jwk.d) throw new ConfigError(`${name} must be the public key only`);
  return importJWK(jwk, "EdDSA") as Promise<CryptoKey | KeyObject>;
}

export function parseSigningJwks(env: Env): { keys: JWK[] } {
  const jwks = parseJson<{ keys?: JWK[] }>(env, "IDENTITY_OIDC_JWKS");
  const keys = jwks.keys ?? [];
  if (keys.length < 1 || keys.length > 2)
    throw new ConfigError("IDENTITY_OIDC_JWKS must hold 1 or 2 keys (2 only during rotation)");
  const kids = new Set<string>();
  for (const k of keys) {
    if (k.kty !== "EC" || k.crv !== "P-256" || !k.d)
      throw new ConfigError("IDENTITY_OIDC_JWKS keys must be private EC P-256 keys");
    if (!k.kid) throw new ConfigError("IDENTITY_OIDC_JWKS keys need a kid");
    if (kids.has(k.kid)) throw new ConfigError(`IDENTITY_OIDC_JWKS has a duplicate kid ${k.kid}`);
    kids.add(k.kid);
  }
  return { keys: keys.map((k) => ({ ...k, alg: "ES256", use: "sig" })) };
}

/** localhost, *.localhost, 127.0.0.0/8, ::1 and 0.0.0.0. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::1" || h === "0.0.0.0"
  );
}

/**
 * Defence in depth (architect, OS-D1 review; CodeRabbit on #30): loopback
 * hand-off targets are allowed ONLY when NODE_ENV is exactly "development".
 * Anything else (production, a typo, an unset variable) refuses them, so a dev
 * env file copied into a deployment fails loudly at startup instead of
 * trusting the local dev login stub that signs in anyone.
 */
export function refuseLoopbackOutsideDevelopment(env: Env, urls: Record<string, string>): void {
  if (env.NODE_ENV === "development") return;
  for (const [name, url] of Object.entries(urls)) {
    if (isLoopbackHost(new URL(url).hostname)) {
      throw new ConfigError(
        `${name} points at a loopback host, which is only allowed with NODE_ENV=development (got "${env.NODE_ENV ?? ""}")`,
      );
    }
  }
}

export async function loadConfig(env: Env = process.env): Promise<IdentityConfig> {
  const issuer = required(env, "IDENTITY_ISSUER").replace(/\/$/, "");
  const issuerUrl = new URL(issuer);
  const local = issuerUrl.hostname === "localhost" || issuerUrl.hostname === "127.0.0.1";
  if (issuerUrl.protocol !== "https:" && !local) throw new ConfigError("IDENTITY_ISSUER must be https");

  const cookieKeys = required(env, "IDENTITY_COOKIE_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!cookieKeys.length || cookieKeys.some((k) => k.length < 32)) {
    throw new ConfigError("IDENTITY_COOKIE_KEYS must be comma-separated keys of at least 32 characters");
  }

  const method = env.IDENTITY_LOGIN_METHOD ?? "hub";
  if (method !== "hub" && method !== "sms") throw new ConfigError("IDENTITY_LOGIN_METHOD must be hub or sms");
  const login = method === "sms" ? parseSmsLogin(env, { local }) : await parseHubLogin(env, { local });
  refuseLoopbackOutsideDevelopment(env, {
    IDENTITY_ISSUER: issuer,
    ...(login.method === "hub" ? { IDENTITY_HUB_CONTINUE_URL: login.hubContinueUrl } : {}),
    ...(login.method === "sms" ? { IDENTITY_HOME_URL: login.homeUrl } : {}),
  });

  const clientsFile = required(env, "IDENTITY_CLIENTS_FILE");
  let clientConfig: ClientConfigFile;
  try {
    clientConfig = JSON.parse(readFileSync(clientsFile, "utf8")) as ClientConfigFile;
  } catch {
    throw new ConfigError(`IDENTITY_CLIENTS_FILE (${clientsFile}) can't be read as JSON`);
  }

  return {
    issuer,
    port: Number(env.PORT ?? 3000),
    redisUrl: required(env, "IDENTITY_REDIS_URL"),
    jwks: parseSigningJwks(env),
    cookieKeys,
    clients: loadClients(clientConfig, env, { allowLocalhost: local }),
    trustProxy: env.IDENTITY_TRUST_PROXY !== "false",
    login,
  };
}

async function parseHubLogin(env: Env, opts: { local: boolean }): Promise<HubLoginConfig> {
  const hubContinueUrl = required(env, "IDENTITY_HUB_CONTINUE_URL");
  if (new URL(hubContinueUrl).protocol !== "https:" && !opts.local)
    throw new ConfigError("IDENTITY_HUB_CONTINUE_URL must be https");
  return {
    method: "hub",
    accountsDatabaseUrl: required(env, "IDENTITY_ACCOUNTS_DATABASE_URL"),
    handoffPrivateKey: await ed25519(env, "IDENTITY_HANDOFF_PRIVATE_JWK", "private"),
    hubPublicKey: await ed25519(env, "IDENTITY_HUB_PUBLIC_JWK", "public"),
    hubContinueUrl,
  };
}

function integerIn(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** The SMS login method's settings. Exported for tests; `local` = the issuer is on localhost. */
export function parseSmsLogin(env: Env, opts: { local: boolean }): SmsLoginConfig {
  const otpSecret = required(env, "IDENTITY_OTP_SECRET");
  if (otpSecret.length < 32) throw new ConfigError("IDENTITY_OTP_SECRET must be at least 32 characters");

  let allowedPrefixes: string[];
  try {
    allowedPrefixes = parsePrefixes(env.IDENTITY_SMS_ALLOWED_PREFIXES ?? "+32");
  } catch {
    throw new ConfigError("IDENTITY_SMS_ALLOWED_PREFIXES must be a comma-separated list like +32,+31");
  }

  const homeUrl = env.IDENTITY_HOME_URL ?? "https://asafarim.site/";
  let home: URL;
  try {
    home = new URL(homeUrl);
  } catch {
    throw new ConfigError("IDENTITY_HOME_URL must be a URL");
  }
  if (home.protocol !== "https:" && !(opts.local && isLoopbackHost(home.hostname)))
    throw new ConfigError("IDENTITY_HOME_URL must be https");

  let bootstrapAdminPhone: string | null = null;
  if (env.IDENTITY_BOOTSTRAP_ADMIN_PHONE) {
    bootstrapAdminPhone = normalizePhone(env.IDENTITY_BOOTSTRAP_ADMIN_PHONE);
    if (!bootstrapAdminPhone || !isE164(bootstrapAdminPhone))
      throw new ConfigError("IDENTITY_BOOTSTRAP_ADMIN_PHONE must be a full international number (+32…)");
  }

  const provider = env.IDENTITY_SMS_PROVIDER ?? "twilio";
  let sender: SmsLoginConfig["sender"];
  if (provider === "twilio") {
    const accountSid = required(env, "IDENTITY_TWILIO_ACCOUNT_SID");
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new ConfigError("IDENTITY_TWILIO_ACCOUNT_SID must look like AC…");
    sender = {
      provider: "twilio",
      twilio: {
        accountSid,
        authToken: required(env, "IDENTITY_TWILIO_AUTH_TOKEN"),
        from: required(env, "IDENTITY_TWILIO_FROM"),
      },
    };
  } else if (provider === "dev-log") {
    // Codes in the service's own output: development only, never where real people sign in.
    if (env.NODE_ENV !== "development" || !opts.local)
      throw new ConfigError("IDENTITY_SMS_PROVIDER=dev-log is only allowed with NODE_ENV=development on localhost");
    sender = { provider: "dev-log" };
  } else {
    throw new ConfigError("IDENTITY_SMS_PROVIDER must be twilio or dev-log");
  }

  return {
    method: "sms",
    databaseUrl: required(env, "IDENTITY_DATABASE_URL"),
    otpSecret,
    allowedPrefixes,
    dailySmsLimit: integerIn(env, "IDENTITY_SMS_DAILY_LIMIT", 200, 1, 100_000),
    homeUrl: home.href,
    bootstrapAdminPhone,
    sender,
  };
}
