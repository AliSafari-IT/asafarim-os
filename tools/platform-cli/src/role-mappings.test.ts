import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { asMappingList, formatMappings, parseMappingArgs, roleMappingCommand } from "./role-mappings.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "role-map-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };
const MAPPING = {
  id: 3,
  source: "core.admin",
  target: "knowledge.author",
  createdBy: "user:ann",
  createdAt: "2026-11-26T10:00:00.000Z",
  derivedGrants: 2,
};

function reply(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("role mappings: arguments", () => {
  it("takes exact role keys and a numeric id, nothing else", () => {
    expect(parseMappingArgs(["mappings"])).toEqual({ action: "mappings", json: false });
    expect(parseMappingArgs(["mappings", "--json"])).toEqual({ action: "mappings", json: true });
    expect(parseMappingArgs(["map", "core.admin", "knowledge.author"])).toEqual({
      action: "map",
      source: "core.admin",
      target: "knowledge.author",
    });
    expect(parseMappingArgs(["unmap", "12"])).toEqual({ action: "unmap", id: 12 });
    for (const bad of [
      ["map", "core.admin"],
      ["map", "core.*", "knowledge.author"],
      ["map", "Core.admin", "knowledge.author"],
      ["map", "a.b", "c.d", "e.f"],
      ["unmap", "0"],
      ["unmap", "x"],
      ["mappings", "--app", "x"],
    ]) {
      expect(parseMappingArgs(bad), bad.join(" ")).toBeNull();
    }
  });
});

describe("role mappings: replies", () => {
  it("lists mappings, and says how to create one when there are none", () => {
    expect(asMappingList({ mappings: [MAPPING] })).toEqual([MAPPING]);
    expect(asMappingList({ mappings: [{ id: "3" }] })).toBeNull();
    expect(formatMappings([])[0]).toMatch(/role map <source> <target>/);
    const lines = formatMappings([MAPPING]);
    expect(lines[0]).toMatch(/^Id\s+Mapping\s+Held through it\s+Created\s+By$/);
    expect(lines[1]).toMatch(/^3\s+core\.admin → knowledge\.author\s+2\s+2026-11-26 10:00 UTC\s+user:ann$/);
  });

  it("map POSTs the pair and reports who got the role", async () => {
    const f = reply(201, { id: 3, source: "core.admin", target: "knowledge.author", derivedGrants: 1 });
    const r = await roleMappingCommand(["map", "core.admin", "knowledge.author"], workspace(), ENV, f);
    expect(r).toEqual({
      ok: true,
      lines: ["Mapping 3: whoever holds core.admin now also holds knowledge.author (1 new derived grant)."],
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.method, init.body]).toEqual([
      "http://localhost:4020/admin/v1/role-mappings",
      "POST",
      JSON.stringify({ source: "core.admin", target: "knowledge.author" }),
    ]);
  });

  it("unmap DELETEs by id; a refusal says nothing changed", async () => {
    const ok = reply(200, { id: 3, source: "core.admin", target: "knowledge.author", removedGrants: 2 });
    expect((await roleMappingCommand(["unmap", "3"], workspace(), ENV, ok))?.lines[0]).toBe(
      "Mapping 3 (core.admin → knowledge.author) deleted; 2 derived grants removed. Deliberate grants stay.",
    );
    expect((ok.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
    const missing = await roleMappingCommand(["unmap", "9"], workspace(), ENV, reply(404, { error: "not_found" }));
    expect(missing).toEqual({ ok: false, lines: ["core-api has no role mapping 9.", "Nothing was deleted."] });
    const intoCore = await roleMappingCommand(
      ["map", "knowledge.author", "core.admin"],
      workspace(),
      ENV,
      reply(400, { error: "bad_request", message: "a mapping can't grant a core role" }),
    );
    expect(intoCore).toEqual({
      ok: false,
      lines: ["core-api refused: bad_request (a mapping can't grant a core role)", "No mapping was created."],
    });
  });

  it("a lost answer doesn't claim nothing changed: it says to check", async () => {
    const lost = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    for (const args of [
      ["map", "core.admin", "knowledge.author"],
      ["unmap", "3"],
    ]) {
      const r = await roleMappingCommand(args, workspace(), ENV, lost);
      expect(r?.ok).toBe(false);
      expect(r?.lines.at(-1)).toMatch(/may have made the change: run `platform role mappings`/);
    }
  });
});
