/**
 * Environment for the identity service. Every secret comes from env (the
 * deployment's encrypted env file); nothing secret is read from disk except the
 * client config, which names env vars for client secrets instead of holding them.
 */
import { readFileSync } from "node:fs";
import { importJWK, type CryptoKey, type JWK, type KeyObject } from "jose";
import { loadClients, type ClientConfigFile, type OidcClient } from "./clients.ts";

export interface IdentityConfig {
  issuer: string;
  port: number;
  redisUrl: string;
  accountsDatabaseUrl: string;
  /** Private OIDC signing keys (EC P-256, ES256). The first one signs; the rest stay in JWKS for rotation. */
  jwks: { keys: JWK[] };
  cookieKeys: string[];
  handoffPrivateKey: CryptoKey | KeyObject;
  hubPublicKey: CryptoKey | KeyObject;
  hubContinueUrl: string;
  clients: OidcClient[];
  trustProxy: boolean;
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

  const hubContinueUrl = required(env, "IDENTITY_HUB_CONTINUE_URL");
  if (new URL(hubContinueUrl).protocol !== "https:" && !local)
    throw new ConfigError("IDENTITY_HUB_CONTINUE_URL must be https");

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
    accountsDatabaseUrl: required(env, "IDENTITY_ACCOUNTS_DATABASE_URL"),
    jwks: parseSigningJwks(env),
    cookieKeys,
    handoffPrivateKey: await ed25519(env, "IDENTITY_HANDOFF_PRIVATE_JWK", "private"),
    hubPublicKey: await ed25519(env, "IDENTITY_HUB_PUBLIC_JWK", "public"),
    hubContinueUrl,
    clients: loadClients(clientConfig, env, { allowLocalhost: local }),
    trustProxy: env.IDENTITY_TRUST_PROXY !== "false",
  };
}
