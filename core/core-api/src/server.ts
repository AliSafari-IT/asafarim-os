/**
 * core-api over HTTP (P3.1). Entry point: `node src/server.ts`.
 *
 *   GET  /healthz                              live
 *   GET  /readyz                               the core database answers
 *   POST /registry/v1/apps/:id                 signed self-registration (the app)
 *   POST /admin/v1/apps/:id/install            body: the manifest JSON (admin)
 *   POST /admin/v1/apps/:id/activate|deactivate                         (admin)
 *   GET  /admin/v1/apps/:id                                             (admin)
 *   POST /registry/v1/apps/:id/subjects/:sub/token   a short-lived access token (the app, signed)
 *   GET  /.well-known/jwks.json                      the keys that verify those tokens
 *   GET  /authz/check                                the gateway's forward_auth hook (Caddy)
 *   GET  /admin/v1/gateway/apps                      what the gateway serves right now (admin)
 *
 * Admin endpoints take `Authorization: Bearer …` with either the static CLI token
 * (CORE_API_ADMIN_TOKEN: bootstrap and CI; can be rotated or switched off) or a
 * person's identity ID token from the Admin console, for a holder of `core.admin`
 * (see admin-auth.ts). More admin endpoints (P3.3b):
 *   GET  /admin/v1/session                       who the caller is
 *   GET  /admin/v1/apps                          every app with its state
 *   GET  /admin/v1/roles[?app=<id>]              roles, permissions, holders, what needs migrating
 *   GET  /admin/v1/roles/<role>/grants           who holds a role
 *   GET  /admin/v1/subjects/<sub>/grants         what a person holds
 *   GET  /admin/v1/audit[?app=&actor=&limit=&before=]   the audit log, newest first
 *   GET  /registry/v1/apps/:id/launcher/:sub     the apps a person can open (the app, signed)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import pg from "pg";
import { createStreamAdmin } from "@asafarim/events";
import { createAdminQueries } from "./admin.ts";
import {
  CORE_ADMIN_ROLE,
  bearerMatches,
  createAdminAuth,
  createIdentityVerifier,
  type IdentityVerifier,
} from "./admin-auth.ts";
import { ApiError } from "./errors.ts";
import { migrate } from "./migrate.ts";
import { createAppSnapshot, createGateway, type GatewayApp } from "./gateway.ts";
import { createRegistry, type Registry } from "./registry.ts";
import { jwksOf, verificationKeyOf, type SigningKey } from "@asafarim/registry-protocol";

const MAX_BODY = 256 * 1024;
const APP_ID = "([a-z][a-z0-9-]{1,31})";

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError("bad_request", "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Kept for the tests and callers of the old name: see bearerMatches (admin-auth.ts). */
export const adminTokenMatches = bearerMatches;

const SUBJECT = /^[A-Za-z0-9._:@-]{1,128}$/;

/** A subject from a URL segment: percent-decoded, then validated (clients encode `:` and `@`). */
export function decodeSubject(segment: string): string {
  let subject: string;
  try {
    subject = decodeURIComponent(segment);
  } catch {
    throw new ApiError("bad_request", "the subject isn't valid percent-encoding");
  }
  if (!SUBJECT.test(subject)) throw new ApiError("bad_request", "the subject has characters that aren't allowed");
  return subject;
}

/** The port put into an installed app's DATABASE_URL. URL.port is "" (not undefined) when the URL has none. */
export function appDatabasePort(override: string | undefined, provisioner: URL): number {
  return Number(override || provisioner.port || 5432);
}

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function createHandler(opts: {
  registry: Registry;
  pool: pg.Pool;
  /** The static CLI token. Undefined = switched off (CORE_API_ADMIN_TOKEN_DISABLED): only people with core.admin may call the admin API. */
  adminToken?: string;
  /** Verifies the Admin console's identity tokens. Without it only the static token works. */
  identity?: IdentityVerifier;
  log?: (line: object) => void;
  /** The token signing key (P3.3a). Without it there's no JWKS and the gateway hook refuses every permission-marked route. */
  tokenKey?: SigningKey;
  /** The snapshot the gateway reads the apps from; share it with the registry so lifecycle changes drop it. */
  snapshot?: ReturnType<typeof createAppSnapshot>;
  /** The clock tokens are checked against (tests move it; production uses the real one). */
  now?: () => Date;
}) {
  const log = opts.log ?? ((l) => process.stdout.write(`${JSON.stringify({ service: "core-api", ...l })}\n`));
  const snapshot = opts.snapshot ?? createAppSnapshot(() => loadGatewayApps(opts.pool));
  const keys = opts.tokenKey ? [verificationKeyOf(opts.tokenKey)] : [];
  const gateway = createGateway({ apps: snapshot.apps, keys: () => keys, now: opts.now });
  const queries = createAdminQueries(opts.pool);
  const authorizeAdmin = createAdminAuth({
    staticToken: opts.adminToken,
    identity: opts.identity,
    holdsRole: queries.holdsRole,
    log,
  });
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://core-api");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "GET" && p === "/readyz") {
        try {
          await opts.pool.query("SELECT 1");
          return json(res, 200, { ok: true, checks: { database: true } });
        } catch {
          return json(res, 503, { ok: false, checks: { database: false } });
        }
      }

      if (req.method === "GET" && p === "/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
        return void res.end(JSON.stringify(jwksOf(keys)));
      }
      if (p === "/authz/check" && (req.method === "GET" || req.method === "HEAD")) {
        const out = await gateway.check({
          appId: header(req, "x-asafarim-app"),
          method: header(req, "x-forwarded-method"),
          uri: header(req, "x-forwarded-uri"),
          cookie: header(req, "cookie"),
          accept: header(req, "accept"),
        });
        res.writeHead(out.status, out.headers);
        return void res.end(out.body);
      }

      let m = new RegExp(`^/registry/v1/apps/${APP_ID}$`).exec(p);
      if (m && req.method === "POST") {
        const body = await readBody(req);
        const headers = Object.fromEntries(
          ["x-asafarim-timestamp", "x-asafarim-nonce", "x-asafarim-key-id", "x-asafarim-signature"].map((h) => [
            h,
            header(req, h),
          ]),
        );
        const out = await opts.registry.register(m[1]!, headers, body);
        log({ msg: "app.registered", appId: m[1], version: out.version });
        return json(res, 200, out);
      }

      m = new RegExp(`^/registry/v1/apps/${APP_ID}/subjects/([^/]{1,400})$`).exec(p);
      if (m && req.method === "GET") {
        const subject = decodeSubject(m[2]!);
        const headers = Object.fromEntries(
          ["x-asafarim-timestamp", "x-asafarim-nonce", "x-asafarim-key-id", "x-asafarim-signature"].map((h) => [
            h,
            header(req, h),
          ]),
        );
        // The signature covers the path exactly as the app sent it (encoded), so verify against the raw path.
        return json(res, 200, await opts.registry.subjectAccess(m[1]!, subject, headers, p));
      }

      m = new RegExp(`^/registry/v1/apps/${APP_ID}/subjects/([^/]{1,400})/token$`).exec(p);
      if (m && req.method === "POST") {
        const subject = decodeSubject(m[2]!);
        const headers = Object.fromEntries(
          ["x-asafarim-timestamp", "x-asafarim-nonce", "x-asafarim-key-id", "x-asafarim-signature"].map((h) => [
            h,
            header(req, h),
          ]),
        );
        return json(res, 200, await opts.registry.issueAccessToken(m[1]!, subject, headers, p));
      }

      m = new RegExp(`^/registry/v1/apps/${APP_ID}/launcher/([^/]{1,400})$`).exec(p);
      if (m && req.method === "GET") {
        const subject = decodeSubject(m[2]!);
        const headers = Object.fromEntries(
          ["x-asafarim-timestamp", "x-asafarim-nonce", "x-asafarim-key-id", "x-asafarim-signature"].map((h) => [
            h,
            header(req, h),
          ]),
        );
        return json(res, 200, await opts.registry.launcher(m[1]!, subject, headers, p));
      }

      if (p.startsWith("/admin/v1/")) {
        const caller = await authorizeAdmin(req.headers.authorization);
        const actor = caller.actor;
        if (req.method === "GET" && p === "/admin/v1/session") return json(res, 200, caller);
        if (req.method === "GET" && p === "/admin/v1/apps") return json(res, 200, { apps: await queries.listApps() });
        if (req.method === "GET" && p === "/admin/v1/roles") {
          const app = url.searchParams.get("app") ?? undefined;
          if (app !== undefined && !new RegExp(`^${APP_ID}$`).test(app) && app !== "core") {
            throw new ApiError("bad_request", "app isn't a valid app id");
          }
          return json(res, 200, { roles: await queries.listRoles(app) });
        }
        m = /^\/admin\/v1\/roles\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)\/grants$/.exec(p);
        if (m && req.method === "GET") return json(res, 200, { role: m[1], grants: await queries.roleGrants(m[1]!) });
        m = /^\/admin\/v1\/subjects\/([^/]{1,400})\/grants$/.exec(p);
        if (m && req.method === "GET") {
          const subject = decodeSubject(m[1]!);
          return json(res, 200, { subject, grants: await queries.subjectGrants(subject) });
        }
        if (req.method === "GET" && p === "/admin/v1/audit") {
          const num = (name: string) => {
            const v = url.searchParams.get(name);
            if (v === null || v === "") return undefined;
            if (!/^\d{1,12}$/.test(v)) throw new ApiError("bad_request", `${name} must be a whole number`);
            return Number(v);
          };
          const app = url.searchParams.get("app") || undefined;
          const who = url.searchParams.get("actor") || undefined;
          if (who !== undefined && who.length > 128) throw new ApiError("bad_request", "actor is too long");
          return json(res, 200, await queries.audit({ app, actor: who, limit: num("limit"), before: num("before") }));
        }
        if (req.method === "GET" && p === "/admin/v1/gateway/apps") {
          return json(res, 200, {
            apps: (await snapshot.apps()).map((a) => ({
              id: a.id,
              state: a.state,
              serving: a.state === "active",
              routes: a.manifest.routes ?? [],
            })),
          });
        }
        m = /^\/admin\/v1\/roles\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)\/grants\/([^/]{1,400})$/.exec(p);
        if (m && (req.method === "PUT" || req.method === "DELETE")) {
          const subject = decodeSubject(m[2]!);
          // A person can't take core.admin away from themselves: that would lock them out of the console.
          if (req.method === "DELETE" && m[1] === CORE_ADMIN_ROLE && caller.subject === subject) {
            throw new ApiError("invalid_state", `you can't revoke your own ${CORE_ADMIN_ROLE}; ask another admin`);
          }
          const out =
            req.method === "PUT"
              ? await opts.registry.grantRole(m[1]!, subject, actor)
              : await opts.registry.revokeRole(m[1]!, subject, actor);
          log({ msg: req.method === "PUT" ? "role.granted" : "role.revoked", role: m[1], actor });
          return json(res, 200, out);
        }

        m = new RegExp(`^/admin/v1/apps/${APP_ID}/install$`).exec(p);
        if (m && req.method === "POST") {
          let manifest: unknown;
          try {
            manifest = JSON.parse(await readBody(req));
          } catch {
            throw new ApiError("bad_request", "the body must be the manifest as JSON");
          }
          const out = await opts.registry.install(m[1]!, manifest, actor);
          log({ msg: "app.installed", appId: m[1], actor });
          return json(res, 201, out);
        }
        m = new RegExp(`^/admin/v1/apps/${APP_ID}/(activate|deactivate)$`).exec(p);
        if (m && req.method === "POST") {
          const out = await opts.registry.transition(m[1]!, m[2] as "activate" | "deactivate", actor);
          log({ msg: `app.${m[2]}d`, appId: m[1], actor });
          return json(res, 200, out);
        }
        m = new RegExp(`^/admin/v1/apps/${APP_ID}$`).exec(p);
        if (m && req.method === "GET") return json(res, 200, await opts.registry.get(m[1]!));
      }
      throw new ApiError("not_found");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status >= 401 && err.status < 404) log({ msg: "request.refused", path: p, error: err.code });
        return json(res, err.status, {
          error: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
      }
      log({ msg: "request.failed", path: p, error: (err as Error).name });
      return json(res, 500, { error: "internal" });
    }
  };
}

/** Every app the gateway might be asked about (removed ones are gone). */
export async function loadGatewayApps(pool: pg.Pool): Promise<GatewayApp[]> {
  const r = await pool.query<GatewayApp>("SELECT id, state, manifest FROM apps WHERE state <> 'removed' ORDER BY id");
  return r.rows;
}

/** CORE_API_ACCESS_TOKEN_TTL_SECONDS: 5–300, default 60. */
export function parseTokenTtl(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 5 || n > 300) {
    throw new Error("CORE_API_ACCESS_TOKEN_TTL_SECONDS must be a whole number of seconds from 5 to 300");
  }
  return n;
}

/** CORE_API_TOKEN_SIGNING_JWK: an Ed25519 private JWK (with `kid`). */
export function parseTokenKey(raw: string): SigningKey {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("CORE_API_TOKEN_SIGNING_JWK isn't valid JSON");
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("CORE_API_TOKEN_SIGNING_JWK must be an Ed25519 private JWK (kty OKP, crv Ed25519, d, x)");
  }
  if (typeof jwk.kid !== "string" || !jwk.kid) throw new Error("CORE_API_TOKEN_SIGNING_JWK needs a kid");
  const { kid, ...privateJwk } = jwk as { kid: string } & Record<string, unknown>;
  return { kid, privateJwk: privateJwk as SigningKey["privateJwk"] };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** CORE_API_ADMIN_TOKEN: required (≥ 32 characters) unless CORE_API_ADMIN_TOKEN_DISABLED=true switches the CLI token off. */
export function parseAdminToken(env: Record<string, string | undefined>): string | undefined {
  if (env.CORE_API_ADMIN_TOKEN_DISABLED === "true") return undefined;
  const token = env.CORE_API_ADMIN_TOKEN;
  if (!token)
    throw new Error("CORE_API_ADMIN_TOKEN is not set (or set CORE_API_ADMIN_TOKEN_DISABLED=true to switch it off)");
  if (token.length < 32) throw new Error("CORE_API_ADMIN_TOKEN must be at least 32 characters");
  return token;
}

async function main() {
  const adminToken = parseAdminToken(process.env);
  // People sign in to the Admin console through core/identity; core-api verifies their ID token.
  const identityIssuer = process.env.CORE_API_IDENTITY_ISSUER;
  const identity = identityIssuer
    ? createIdentityVerifier({
        issuer: identityIssuer,
        audience: process.env.CORE_API_ADMIN_CLIENT_ID ?? "core-admin",
      })
    : undefined;
  if (adminToken === undefined && !identity) {
    throw new Error("the admin token is off and CORE_API_IDENTITY_ISSUER isn't set: nobody could call the admin API");
  }
  const pool = new pg.Pool({ connectionString: required("CORE_API_DATABASE_URL"), max: 8 });
  const applied = await migrate(pool);
  const provisionerUrl = required("CORE_API_PROVISIONER_URL");
  const appDb = new URL(provisionerUrl);
  const appDbPort = appDatabasePort(process.env.CORE_API_APP_DB_PORT, appDb);
  const tokenKey = parseTokenKey(required("CORE_API_TOKEN_SIGNING_JWK"));
  const snapshot = createAppSnapshot(() => loadGatewayApps(pool));
  // P4.1: with a bus configured, installing (or re-registering) an app creates its JetStream stream
  // when it publishes, and its durable consumers when it subscribes.
  const natsUrl = process.env.CORE_API_NATS_URL;
  const bus = natsUrl ? createStreamAdmin({ servers: natsUrl.split(","), name: "core-api" }) : undefined;
  // The shared DEADLETTER stream: ensured at boot, and again before any consumer is created, so a
  // bus that is down now doesn't stop core-api from starting.
  void bus?.ensureDeadLetterStream().then(
    ({ stream, result }) =>
      process.stdout.write(`${JSON.stringify({ service: "core-api", msg: "events.deadletter", stream, result })}\n`),
    (err: Error) =>
      process.stderr.write(
        `${JSON.stringify({ service: "core-api", msg: "events.deadletter_unavailable", error: err.message })}\n`,
      ),
  );
  const registry = createRegistry({
    bus,
    pool,
    tokenKey,
    accessTokenTtlSeconds: parseTokenTtl(process.env.CORE_API_ACCESS_TOKEN_TTL_SECONDS),
    appUrlTemplate: process.env.CORE_API_APP_URL_TEMPLATE || undefined,
    onLifecycleChange: () => snapshot.invalidate(),
    provisioner: async () => {
      const c = new pg.Client({ connectionString: provisionerUrl });
      await c.connect();
      return c;
    },
    appDatabaseHost: {
      host: process.env.CORE_API_APP_DB_HOST ?? appDb.hostname,
      port: appDbPort,
    },
  });
  // Forget expired registration nonces even when nobody registers.
  setInterval(() => void registry.pruneNonces().catch(() => undefined), 60_000).unref();
  const port = Number(process.env.PORT ?? 4020);
  createServer(createHandler({ registry, pool, adminToken, identity, tokenKey, snapshot })).listen(port, () =>
    process.stdout.write(
      `${JSON.stringify({ service: "core-api", msg: "core-api.started", port, migrations: applied })}\n`,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err: Error) => {
    process.stderr.write(
      `${JSON.stringify({ service: "core-api", msg: "core-api.start_failed", error: err.message })}\n`,
    );
    process.exit(1);
  });
}
