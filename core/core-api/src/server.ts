/**
 * core-api over HTTP (P3.1). Entry point: `node src/server.ts`.
 *
 *   GET  /healthz                              live
 *   GET  /readyz                               the core database answers
 *   POST /registry/v1/apps/:id                 signed self-registration (the app)
 *   POST /admin/v1/apps/:id/install            body: the manifest JSON (admin)
 *   POST /admin/v1/apps/:id/activate|deactivate                         (admin)
 *   GET  /admin/v1/apps/:id                                             (admin)
 *
 * Admin endpoints take `Authorization: Bearer <CORE_API_ADMIN_TOKEN>` for now;
 * OIDC admin sign-in replaces it when the admin console arrives.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import pg from "pg";
import { ApiError } from "./errors.ts";
import { migrate } from "./migrate.ts";
import { createRegistry, type Registry } from "./registry.ts";

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

/**
 * Compare SHA-256 digests (always the same length) with timingSafeEqual, so
 * neither the content nor the length of the admin token leaks through timing.
 */
export function adminTokenMatches(authorization: string | undefined, token: string): boolean {
  const got = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(got), digest(token));
}

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

const adminOk = (req: IncomingMessage, token: string) => adminTokenMatches(req.headers.authorization, token);

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function createHandler(opts: {
  registry: Registry;
  pool: pg.Pool;
  adminToken: string;
  log?: (line: object) => void;
}) {
  const log = opts.log ?? ((l) => process.stdout.write(`${JSON.stringify({ service: "core-api", ...l })}\n`));
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

      if (p.startsWith("/admin/v1/")) {
        if (!adminOk(req, opts.adminToken)) throw new ApiError("unauthorized");
        m = /^\/admin\/v1\/roles\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)\/grants\/([^/]{1,400})$/.exec(p);
        if (m && (req.method === "PUT" || req.method === "DELETE")) {
          const subject = decodeSubject(m[2]!);
          const out =
            req.method === "PUT"
              ? await opts.registry.grantRole(m[1]!, subject, "admin")
              : await opts.registry.revokeRole(m[1]!, subject, "admin");
          log({ msg: req.method === "PUT" ? "role.granted" : "role.revoked", role: m[1] });
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
          const out = await opts.registry.install(m[1]!, manifest, "admin");
          log({ msg: "app.installed", appId: m[1] });
          return json(res, 201, out);
        }
        m = new RegExp(`^/admin/v1/apps/${APP_ID}/(activate|deactivate)$`).exec(p);
        if (m && req.method === "POST") {
          const out = await opts.registry.transition(m[1]!, m[2] as "activate" | "deactivate", "admin");
          log({ msg: `app.${m[2]}d`, appId: m[1] });
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

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const adminToken = required("CORE_API_ADMIN_TOKEN");
  if (adminToken.length < 32) throw new Error("CORE_API_ADMIN_TOKEN must be at least 32 characters");
  const pool = new pg.Pool({ connectionString: required("CORE_API_DATABASE_URL"), max: 8 });
  const applied = await migrate(pool);
  const provisionerUrl = required("CORE_API_PROVISIONER_URL");
  const appDb = new URL(provisionerUrl);
  const appDbPort = appDatabasePort(process.env.CORE_API_APP_DB_PORT, appDb);
  const registry = createRegistry({
    pool,
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
  createServer(createHandler({ registry, pool, adminToken })).listen(port, () =>
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
