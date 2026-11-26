/**
 * Role mappings from the command line (#355, ADR 0004): whoever holds the source role also holds the target.
 *
 *   platform role mappings [--json]          every mapping, with how many people hold its target through it
 *   platform role map <source> <target>      create one (admin); its source's holders get the target at once
 *   platform role unmap <id>                 delete one; only the grants derived from it go
 *
 * It talks to the admin API as `role list` does (`adminEndpoint`). Exit code 0 when core-api did it, 1 otherwise.
 */
import { adminEndpoint } from "./app.ts";
import { commonRefusal, formatDate, request } from "./retention.ts";
import { clean } from "./status.ts";

type Result = { ok: boolean; lines: string[]; stdout?: boolean };

const ROLE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const ID = /^[1-9]\d{0,17}$/;

export type MappingArgs =
  | { action: "mappings"; json: boolean }
  | { action: "map"; source: string; target: string }
  | { action: "unmap"; id: number };

/** `role mappings|map|unmap …` (the words after `role`); null = not valid (the usage is printed). */
export function parseMappingArgs(args: string[]): MappingArgs | null {
  const [action, ...rest] = args;
  if (action === "mappings") {
    if (rest.length === 0) return { action, json: false };
    return rest.length === 1 && rest[0] === "--json" ? { action, json: true } : null;
  }
  if (action === "map") {
    const [source, target] = rest;
    if (rest.length !== 2 || !ROLE.test(source!) || !ROLE.test(target!)) return null;
    return { action, source: source!, target: target! };
  }
  if (action === "unmap") return rest.length === 1 && ID.test(rest[0]!) ? { action, id: Number(rest[0]) } : null;
  return null;
}

/** One mapping (mirrors core-api's `RoleMapping`, core/core-api/src/role-mappings.ts). */
export interface ListedMapping {
  id: number;
  source: string;
  target: string;
  createdBy: string;
  createdAt: string;
  derivedGrants: number;
}

export function asMappingList(out: unknown): ListedMapping[] | null {
  if (typeof out !== "object" || out === null || !Array.isArray((out as { mappings?: unknown }).mappings)) return null;
  const list = (out as { mappings: unknown[] }).mappings;
  const fits = list.every((m) => {
    const x = m as Partial<ListedMapping> | null;
    return x !== null && typeof x === "object" && typeof x.id === "number" && typeof x.source === "string";
  });
  return fits ? (list as ListedMapping[]) : null;
}

export function formatMappings(list: ListedMapping[]): string[] {
  if (list.length === 0) return ["No role mappings. `platform role map <source> <target>` creates one."];
  const rows = list.map((m) => [
    String(m.id),
    `${clean(m.source)} → ${clean(m.target)}`,
    typeof m.derivedGrants === "number" ? String(m.derivedGrants) : "?",
    clean(formatDate(m.createdAt)),
    clean(m.createdBy),
  ]);
  const header = ["Id", "Mapping", "Held through it", "Created", "By"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

export async function roleMappingCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseMappingArgs(args);
  if (!p) return null;
  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  if (p.action === "mappings") {
    const r = await request(target, "GET", "/admin/v1/role-mappings", fetchImpl);
    if (!r.ok) return { ok: false, lines: commonRefusal(r, "", "").filter(Boolean) };
    const list = asMappingList(r.out);
    if (!list)
      return { ok: false, lines: ["core-api's reply to GET /admin/v1/role-mappings isn't what this CLI expects."] };
    return { ok: true, stdout: true, lines: p.json ? [JSON.stringify(r.out, null, 2)] : formatMappings(list) };
  }
  if (p.action === "map") {
    const r = await request(target, "POST", "/admin/v1/role-mappings", fetchImpl, {
      source: p.source,
      target: p.target,
    });
    if (!r.ok) {
      const nothing = "No mapping was created.";
      if (!("unreachable" in r) && r.error === "role_not_found")
        return { ok: false, lines: [`core-api refused: ${r.message ?? "no such role"}.`, nothing] };
      return { ok: false, lines: commonRefusal(r, "", nothing).filter(Boolean) };
    }
    const id = typeof r.out.id === "number" ? r.out.id : "?";
    const n = typeof r.out.derivedGrants === "number" ? r.out.derivedGrants : 0;
    return {
      ok: true,
      lines: [
        `Mapping ${id}: whoever holds ${p.source} now also holds ${p.target} (${n} ${n === 1 ? "person" : "people"} got it now).`,
      ],
    };
  }
  const r = await request(target, "DELETE", `/admin/v1/role-mappings/${p.id}`, fetchImpl);
  if (!r.ok) {
    const nothing = "Nothing was deleted.";
    if (!("unreachable" in r) && r.error === "not_found")
      return { ok: false, lines: [`core-api has no role mapping ${p.id}.`, nothing] };
    return { ok: false, lines: commonRefusal(r, "", nothing).filter(Boolean) };
  }
  const n = typeof r.out.removedGrants === "number" ? r.out.removedGrants : 0;
  const what = `${clean(String(r.out.source ?? "?"))} → ${clean(String(r.out.target ?? "?"))}`;
  return {
    ok: true,
    lines: [
      `Mapping ${p.id} (${what}) deleted; ${n} derived grant${n === 1 ? "" : "s"} removed. Deliberate grants stay.`,
    ],
  };
}
