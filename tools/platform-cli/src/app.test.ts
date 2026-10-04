import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { adminEndpoint, appCommand, roleCommand } from "./app.ts";

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
  it("an app with no database (database: none) installs with only its credential", async () => {
    const root = workspace();
    const fetchImpl = reply(201, {
      appId: "notes",
      state: "installed",
      credential: "osk1.notes.abcdef012345.KEY",
      database: null,
    });
    const r = await appCommand(
      ["install", "notes"],
      root,
      { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "t".repeat(40) },
      fetchImpl as unknown as typeof fetch,
    );
    expect(r?.ok).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toContain("installed (no database)");
    expect(text).toContain("ASAFARIM_REGISTRY_CREDENTIAL=osk1.notes.abcdef012345.KEY");
    expect(text).not.toContain("DATABASE_URL");

    const out = path.join(root, ".dev", "notes.env");
    mkdirSync(path.dirname(out), { recursive: true });
    const written = await appCommand(
      ["install", "notes", "--env-out", ".dev/notes.env"],
      root,
      { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "t".repeat(40) },
      fetchImpl as unknown as typeof fetch,
    );
    expect(written?.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(
      "ASAFARIM_APP_ID=notes\nASAFARIM_REGISTRY_CREDENTIAL=osk1.notes.abcdef012345.KEY\n",
    );
  });

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

  it("--env-out outside the workspace is refused BEFORE anything is installed", async () => {
    const fetchImpl = reply(201, {});
    for (const out of ["../outside.env", path.join(tmpdir(), "elsewhere.env"), ".", ""]) {
      const r = await appCommand(
        ["install", "notes", "--env-out", out],
        workspace(),
        { CORE_API_ADMIN_TOKEN: "tok" },
        fetchImpl,
      );
      expect(r?.ok, out).toBe(false);
      expect(r?.lines[0], out).toMatch(/--env-out must name a file inside .*Nothing was installed/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
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

describe("platform role (P3.2)", () => {
  it("grant PUTs the admin endpoint with the token; revoke DELETEs; output says what changed", async () => {
    const root = workspace(false);
    const grant = reply(200, { role: "notes.editor", subject: "dev-member", granted: true });
    const r = await roleCommand(["grant", "notes.editor", "dev-member"], root, { CORE_API_ADMIN_TOKEN: "tok" }, grant);
    expect(r).toEqual({ ok: true, lines: ["notes.editor granted to dev-member"] });
    const [url, init] = grant.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4020/admin/v1/roles/notes.editor/grants/dev-member");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");

    const revoke = reply(200, { role: "notes.editor", subject: "dev-member", revoked: false });
    const r2 = await roleCommand(
      ["revoke", "notes.editor", "dev-member"],
      root,
      { CORE_API_ADMIN_TOKEN: "tok" },
      revoke,
    );
    expect(r2?.lines[0]).toMatch(/no change for dev-member/);
    expect((revoke.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
  });

  it("surfaces core-api's error code, needs a token, and refuses malformed input", async () => {
    const root = workspace(false);
    const r = await roleCommand(
      ["grant", "notes.ghost", "u"],
      root,
      { CORE_API_ADMIN_TOKEN: "t" },
      reply(404, { error: "role_not_found", message: 'no active role "notes.ghost"' }),
    );
    expect(r).toEqual({ ok: false, lines: ['core-api refused: role_not_found (no active role "notes.ghost")'] });
    expect((await roleCommand(["grant", "notes.editor", "u"], root, {}, reply(200, {})))?.lines[0]).toMatch(
      /CORE_API_ADMIN_TOKEN/,
    );
    for (const bad of [
      ["grant", "Notes", "u"],
      ["grant", "notes.editor"],
      ["give", "notes.editor", "u"],
      ["grant", "notes.editor", "a b"],
    ]) {
      expect(await roleCommand(bad, root, { CORE_API_ADMIN_TOKEN: "t" }, reply(200, {}))).toBeNull();
    }
  });
});

describe("where the admin token may be sent (adminEndpoint)", () => {
  function rootWithDevEnv(url: string) {
    const root = workspace(false);
    mkdirSync(path.join(root, ".dev"));
    writeFileSync(
      path.join(root, ".dev", "core-api.env"),
      `CORE_API_URL=${url}
CORE_API_ADMIN_TOKEN=dev-token
`,
    );
    return root;
  }

  it("a loopback URL from the dev env file is fine", () => {
    for (const url of ["http://localhost:4020", "http://127.0.0.1:4020", "http://[::1]:4020"]) {
      expect(adminEndpoint(rootWithDevEnv(url), {})).toMatchObject({ token: "dev-token" });
    }
  });

  it("a non-loopback URL from the dev env file is refused, so a tampered file can't redirect the token", () => {
    const r = adminEndpoint(rootWithDevEnv("https://evil.example"), {});
    expect(r).toEqual({ error: expect.stringContaining("isn't loopback") });
  });

  it("an explicit CORE_API_URL is used as given (any host), but must be a http(s) URL", () => {
    const root = workspace(false);
    expect(adminEndpoint(root, { CORE_API_URL: "https://core.asafarim.site/", CORE_API_ADMIN_TOKEN: "t" })).toEqual({
      baseUrl: "https://core.asafarim.site",
      token: "t",
    });
    expect(adminEndpoint(root, { CORE_API_URL: "ftp://x", CORE_API_ADMIN_TOKEN: "t" })).toEqual({
      error: "CORE_API_URL must be http(s).",
    });
    expect(adminEndpoint(root, { CORE_API_URL: "not a url", CORE_API_ADMIN_TOKEN: "t" })).toEqual({
      error: expect.stringContaining("not a URL"),
    });
  });

  it("the commands refuse before sending anything", async () => {
    const root = rootWithDevEnv("https://evil.example");
    const fetchImpl = reply(200, {});
    const r = await roleCommand(["grant", "notes.editor", "u"], root, {}, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
