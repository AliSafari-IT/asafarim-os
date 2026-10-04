/**
 * `platform app …` (P3.1): talk to core-api's admin API.
 *
 *   platform app install <id> [--env-out <file>]   install apps/<id> (its platform.app.json)
 *   platform app activate <id>
 *   platform app deactivate <id>
 *
 * CORE_API_URL (default http://localhost:4020) and CORE_API_ADMIN_TOKEN come
 * from the environment; locally they fall back to `.dev/core-api.env`, which
 * `pnpm dev` creates. The registry credential and the app's database URL are
 * shown ONCE: `--env-out` writes them to a file (mode 600) instead of printing.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadManifestFile } from "./manifest.ts";

type Result = { ok: boolean; lines: string[] };

function devEnv(root: string): Record<string, string> {
  const file = path.join(root, ".dev", "core-api.env");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {}; // not there: nothing to fall back to
  }
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^'(.*)'$|^"(.*)"$/, "$1$2");
  }
  return env;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where to send admin requests, and with which token. CORE_API_URL and
 * CORE_API_ADMIN_TOKEN from the environment are used as given (point them at
 * any core-api). The `.dev/core-api.env` fallback is for local development
 * only, so a URL that comes from that file must be loopback: a tampered dev
 * file can't redirect the admin token to another host.
 */
export function adminEndpoint(
  root: string,
  env: Record<string, string | undefined>,
): { baseUrl: string; token: string } | { error: string } {
  const fallback = devEnv(root);
  const baseUrl = (env.CORE_API_URL ?? fallback.CORE_API_URL ?? "http://localhost:4020").replace(/\/$/, "");
  const token = env.CORE_API_ADMIN_TOKEN ?? fallback.CORE_API_ADMIN_TOKEN;
  if (!token) return { error: "CORE_API_ADMIN_TOKEN is not set (run `pnpm dev` once locally, or export it)." };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: `CORE_API_URL is not a URL: ${baseUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "CORE_API_URL must be http(s)." };
  if (env.CORE_API_URL === undefined && !LOOPBACK.has(url.hostname)) {
    return {
      error: `.dev/core-api.env points core-api at ${url.hostname}, which isn't loopback; set CORE_API_URL explicitly if that's intended.`,
    };
  }
  return { baseUrl, token };
}

export async function appCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const [action, id, ...rest] = args;
  if (!action || !id || !/^[a-z][a-z0-9-]{1,31}$/.test(id)) return null;
  if (!["install", "activate", "deactivate"].includes(action)) return null;

  // --env-out is checked BEFORE anything is installed: the credential is shown
  // once, so a bad path must not be discovered afterwards. It may only point
  // inside the workspace (never an arbitrary path).
  let envTarget: string | undefined;
  if (action === "install" && rest[0] === "--env-out") {
    const given = rest[1];
    const target = given ? path.resolve(root, given) : undefined;
    const rel = target ? path.relative(root, target) : "";
    if (!target || !rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        ok: false,
        lines: [`--env-out must name a file inside ${root} (got "${given ?? ""}"). Nothing was installed.`],
      };
    }
    envTarget = target;
  }

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };
  const { baseUrl, token } = target;

  let body: string | undefined;
  if (action === "install") {
    const file = path.join(root, "apps", id, "platform.app.json");
    if (!existsSync(file))
      return {
        ok: false,
        lines: [`No ${path.relative(root, file)}: compile the manifest first (platform manifest compile).`],
      };
    body = JSON.stringify(await loadManifestFile(file, { jsonOnly: true }));
  }

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/admin/v1/apps/${id}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
  } catch {
    return { ok: false, lines: [`core-api isn't reachable at ${baseUrl} (is \`pnpm dev\` running?).`] };
  }
  const out = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const lines = [`core-api refused: ${String(out.error)}${out.message ? ` (${String(out.message)})` : ""}`];
    for (const p of (out.details as { path?: string; message?: string }[] | undefined) ?? [])
      lines.push(`  ${p.path ?? ""}: ${p.message ?? ""}`);
    return { ok: false, lines };
  }

  if (action !== "install") return { ok: true, lines: [`${id}: ${String(out.previous)} → ${String(out.state)}`] };

  // An app whose manifest says `database: none` is installed without one.
  const db = out.database as { name: string; url: string } | null;
  const secrets = [`ASAFARIM_APP_ID=${id}`, `ASAFARIM_REGISTRY_CREDENTIAL=${String(out.credential)}`];
  if (db) secrets.push(`DATABASE_URL=${db.url}`);
  const what = db ? `database ${db.name}` : "no database";
  const written = db ? "Credential and DATABASE_URL" : "Credential";
  if (envTarget) {
    writeFileSync(envTarget, `${secrets.join("\n")}\n`, { mode: 0o600 });
    chmodSync(envTarget, 0o600); // writeFile's mode doesn't change an existing file
    return {
      ok: true,
      lines: [
        `${id} installed (${what}). ${written} written to ${path.relative(root, envTarget)} (shown once; keep it secret).`,
      ],
    };
  }
  return {
    ok: true,
    lines: [`${id} installed (${what}). These are shown ONCE; store them in the app's env now:`, "", ...secrets],
  };
}

/**
 * `platform role grant|revoke <role> <subject>` (P3.2): an admin gives a person
 * (their identity `sub`) one of an app's declared roles, or takes it back.
 * Apps only DECLARE roles; this is the only way they're granted.
 */
export async function roleCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const [action, role, subject] = args;
  if (action !== "grant" && action !== "revoke") return null;
  if (!role || !subject || args.length !== 3) return null;
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(role) || !/^[A-Za-z0-9._:@-]{1,128}$/.test(subject)) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };
  const { baseUrl, token } = target;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/admin/v1/roles/${role}/grants/${encodeURIComponent(subject)}`, {
      method: action === "grant" ? "PUT" : "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, lines: [`core-api isn't reachable at ${baseUrl} (is \`pnpm dev\` running?).`] };
  }
  const out = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      lines: [`core-api refused: ${String(out.error)}${out.message ? ` (${String(out.message)})` : ""}`],
    };
  }
  const changed = action === "grant" ? out.granted : out.revoked;
  const verb = action === "grant" ? "granted to" : "revoked from";
  return {
    ok: true,
    lines: [
      changed
        ? `${role} ${verb} ${subject}`
        : `${role}: no change for ${subject} (already ${action === "grant" ? "granted" : "not granted"})`,
    ],
  };
}
