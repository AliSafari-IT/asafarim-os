import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appCommand } from "./app.ts";

function workspace(withManifest = true) {
  const root = mkdtempSync(path.join(tmpdir(), "app-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  if (withManifest) {
    mkdirSync(path.join(root, "apps", "notes"), { recursive: true });
    writeFileSync(path.join(root, "apps", "notes", "platform.app.json"), JSON.stringify({ id: "notes" }));
  }
  return root;
}

const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("platform app (P3.1)", () => {
  it("install posts the compiled manifest with the admin token and prints the secrets once", async () => {
    const root = workspace();
    const fetchImpl = reply(201, {
      appId: "notes",
      state: "installed",
      credential: "osk1.notes.abcdef012345.KEY",
      database: { name: "app_notes", url: "postgres://app_notes:pw@h:1/app_notes" },
    });
    const r = await appCommand(
      ["install", "notes"],
      root,
      { CORE_API_ADMIN_TOKEN: "tok", CORE_API_URL: "http://core:4020/" },
      fetchImpl,
    );
    expect(r?.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core:4020/admin/v1/apps/notes/install");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ id: "notes" });
    expect(r!.lines.join("\n")).toContain("ASAFARIM_REGISTRY_CREDENTIAL=osk1.notes.abcdef012345.KEY");
  });

  it("--env-out writes the secrets to a file instead of printing them", async () => {
    const root = workspace();
    const fetchImpl = reply(201, {
      credential: "osk1.notes.abcdef012345.KEY",
      database: { name: "app_notes", url: "postgres://u:p@h:1/d" },
    });
    const r = await appCommand(
      ["install", "notes", "--env-out", "notes.env"],
      root,
      { CORE_API_ADMIN_TOKEN: "tok" },
      fetchImpl,
    );
    expect(r!.lines.join("\n")).not.toContain("osk1.");
    expect(readFileSync(path.join(root, "notes.env"), "utf8")).toContain("DATABASE_URL=postgres://u:p@h:1/d");
  });

  it("falls back to .dev/core-api.env for the token, and reports core-api's error code", async () => {
    const root = workspace();
    mkdirSync(path.join(root, ".dev"));
    writeFileSync(path.join(root, ".dev", "core-api.env"), "CORE_API_ADMIN_TOKEN=from-dev\n");
    const fetchImpl = reply(409, { error: "invalid_state", message: "can't deactivate an app that is installed" });
    const r = await appCommand(["deactivate", "notes"], root, {}, fetchImpl);
    expect(r).toEqual({
      ok: false,
      lines: ["core-api refused: invalid_state (can't deactivate an app that is installed)"],
    });
    expect(
      ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)
        .authorization,
    ).toBe("Bearer from-dev");
  });

  it("refuses without a token, without a compiled manifest, and on a bad id", async () => {
    expect((await appCommand(["install", "notes"], workspace(), {}, reply(200, {})))?.lines[0]).toMatch(
      /CORE_API_ADMIN_TOKEN/,
    );
    expect(
      (await appCommand(["install", "notes"], workspace(false), { CORE_API_ADMIN_TOKEN: "t" }, reply(200, {})))
        ?.lines[0],
    ).toMatch(/compile the manifest/);
    expect(
      await appCommand(["install", "Bad_Id"], workspace(), { CORE_API_ADMIN_TOKEN: "t" }, reply(200, {})),
    ).toBeNull();
  });
});
