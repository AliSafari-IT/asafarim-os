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
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^'(.*)'$|^"(.*)"$/, "$1$2");
  }
  return env;
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

  const fallback = devEnv(root);
  const baseUrl = (env.CORE_API_URL ?? fallback.CORE_API_URL ?? "http://localhost:4020").replace(/\/$/, "");
  const token = env.CORE_API_ADMIN_TOKEN ?? fallback.CORE_API_ADMIN_TOKEN;
  if (!token)
    return { ok: false, lines: ["CORE_API_ADMIN_TOKEN is not set (run `pnpm dev` once locally, or export it)."] };

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

  const db = out.database as { name: string; url: string };
  const secrets = [
    `ASAFARIM_APP_ID=${id}`,
    `ASAFARIM_REGISTRY_CREDENTIAL=${String(out.credential)}`,
    `DATABASE_URL=${db.url}`,
  ];
  if (envTarget) {
    writeFileSync(envTarget, `${secrets.join("\n")}\n`, { mode: 0o600 });
    chmodSync(envTarget, 0o600); // writeFile's mode doesn't change an existing file
    return {
      ok: true,
      lines: [
        `${id} installed (database ${db.name}). Credential and DATABASE_URL written to ${path.relative(root, envTarget)} (shown once; keep it secret).`,
      ],
    };
  }
  return {
    ok: true,
    lines: [
      `${id} installed (database ${db.name}). These are shown ONCE; store them in the app's env now:`,
      "",
      ...secrets,
    ],
  };
}
