import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  DocNotFoundError,
  SourceUnavailableError,
  createFixtureBackend,
  createGitHubBackend,
  createSource,
  createUnavailableBackend,
} from "../lib/source";

const TOKEN = "github_pat_TEST_TOKEN_never_logged";
const API = "https://api.github.com/repos/example-org/handbook";

/** A stubbed GitHub: a tree per sha and file contents; records every request. */
function stubGitHub() {
  const state = {
    sha: "sha-1",
    tree: ["docs-app.json", "a.md", "dir/b.md", "img/x.png", "img/y.svg", "notes.txt"],
    files: {
      "docs-app.json": JSON.stringify({ owners: [{ path: "dir/**", repo: "example-org/dir" }] }),
      "a.md": "# A\n",
      "dir/b.md": "# B\n",
      "img/x.png": "PNG",
    } as Record<string, string>,
    down: false,
  };
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers as Record<string, string> });
    if (state.down) throw new TypeError("fetch failed");
    if (url === `${API}/git/trees/main?recursive=1`) {
      return Response.json({
        sha: state.sha,
        tree: [...state.tree.map((p) => ({ path: p, type: "blob" })), { path: "dir", type: "tree" }],
      });
    }
    const prefix = `${API}/contents/`;
    const suffix = "?ref=main";
    if (url.startsWith(prefix) && url.endsWith(suffix) && url.length > prefix.length + suffix.length) {
      const p = url.slice(prefix.length, -suffix.length).split("/").map(decodeURIComponent).join("/");
      return p in state.files ? new Response(state.files[p]) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 500 });
  });
  const backend = createGitHubBackend({
    repo: "example-org/handbook",
    branch: "main",
    token: TOKEN,
    fetch: fetchFn as unknown as typeof fetch,
  });
  return { state, calls, backend };
}

describe("the GitHub source (#78)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it("lists .md and images from one Trees call, and reads files through the Contents API with the token", async () => {
    const gh = stubGitHub();
    const source = createSource(gh.backend);
    const listing = await source.listDocs();
    expect(listing.sha).toBe("sha-1");
    expect(listing.entries).toEqual([
      { path: "a.md", kind: "doc" },
      { path: "dir/b.md", kind: "doc" },
      { path: "img/x.png", kind: "image" },
      { path: "img/y.svg", kind: "image" },
    ]);
    expect(listing.owners).toEqual({ ok: true, config: { owners: [{ path: "dir/**", repo: "example-org/dir" }] } });
    expect(await source.readDoc("dir/b.md")).toBe("# B\n");
    expect(gh.calls.map((c) => c.url)).toEqual([
      `${API}/git/trees/main?recursive=1`,
      `${API}/contents/docs-app.json?ref=main`,
      `${API}/contents/dir/b.md?ref=main`,
    ]);
    for (const c of gh.calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(gh.calls[2]!.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("caches the tree for 5 minutes and files by sha; a new sha means new reads", async () => {
    const gh = stubGitHub();
    const source = createSource(gh.backend);
    await source.readDoc("a.md");
    await source.readDoc("a.md");
    await source.listDocs();
    expect(gh.calls).toHaveLength(3); // tree, docs-app.json, a.md: once each

    gh.state.sha = "sha-2";
    gh.state.files["a.md"] = "# A, edited\n";
    vi.setSystemTime(CACHE_TTL_MS - 1);
    expect(await source.readDoc("a.md")).toBe("# A\n"); // still within the TTL
    vi.setSystemTime(CACHE_TTL_MS);
    expect(await source.readDoc("a.md")).toBe("# A, edited\n"); // the tree reloaded: sha-2, so a.md is read again
    expect((await source.listDocs()).sha).toBe("sha-2");
  });

  it("Refresh drops the cache at once", async () => {
    const gh = stubGitHub();
    const source = createSource(gh.backend);
    expect(await source.readDoc("a.md")).toBe("# A\n");
    gh.state.files["a.md"] = "# A, edited a minute ago\n";
    source.refresh();
    expect(await source.readDoc("a.md")).toBe("# A, edited a minute ago\n");
  });

  it("only reads what the listing has, and only as its kind", async () => {
    const source = createSource(stubGitHub().backend);
    await expect(source.readDoc("../secret.md")).rejects.toBeInstanceOf(DocNotFoundError);
    await expect(source.readDoc("notes.txt")).rejects.toBeInstanceOf(DocNotFoundError);
    await expect(source.readDoc("img/x.png")).rejects.toBeInstanceOf(DocNotFoundError);
    await expect(source.readImage("a.md")).rejects.toBeInstanceOf(DocNotFoundError);
    expect(new TextDecoder().decode(await source.readImage("img/x.png"))).toBe("PNG");
  });

  it("GitHub unreachable: SourceUnavailableError (never naming the token), and it isn't cached", async () => {
    const gh = stubGitHub();
    gh.state.down = true;
    const source = createSource(gh.backend);
    const err = await source.listDocs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    gh.state.down = false;
    expect((await source.listDocs()).sha).toBe("sha-1"); // tried again, no stale failure
  });

  it("a GitHub error status is unavailable too", async () => {
    const fetchFn = vi.fn(async () => new Response("rate limited", { status: 403 }));
    const backend = createGitHubBackend({
      repo: "a/b",
      branch: "main",
      token: TOKEN,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(createSource(backend).listDocs()).rejects.toThrow(/GitHub answered 403/);
  });

  it("a 404 on the tree or on docs-app.json is unavailable, not a server error (#79)", async () => {
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    const backend = createGitHubBackend({
      repo: "a/b",
      branch: "main",
      token: TOKEN,
      fetch: missing as unknown as typeof fetch,
    });
    const tree = createSource(backend).listDocs();
    await expect(tree).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(tree).rejects.toThrow("the source repository can't be found");

    const gh = stubGitHub();
    delete gh.state.files["docs-app.json"]; // listed in the tree, but GitHub answers 404
    const owners = createSource(gh.backend).listDocs();
    await expect(owners).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(owners).rejects.toThrow("docs-app.json can't be found");
  });

  it("a broken docs-app.json is reported in the listing, not thrown", async () => {
    const gh = stubGitHub();
    gh.state.files["docs-app.json"] = "{ broken";
    expect((await createSource(gh.backend).listDocs()).owners).toEqual({
      ok: false,
      error: "docs-app.json isn't valid JSON",
    });
  });

  it("refuses a repo or branch that could change the URL", () => {
    const make = (repo: string, branch: string) => () => createGitHubBackend({ repo, branch, token: TOKEN });
    expect(make("a/b/c", "main")).toThrow(/owner\/name/);
    expect(make("a/b", "../x")).toThrow(/branch/);
    expect(make("a/b", "feature/x")).not.toThrow();
  });

  it("with no token outside development there is nothing to read", async () => {
    await expect(createSource(createUnavailableBackend("no token")).listDocs()).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });
});

describe("the fixture source (local development)", () => {
  const source = () => createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));

  it("lists the fake documents and the image, with a valid docs-app.json", async () => {
    const listing = await source().listDocs();
    expect(listing.entries.map((e) => e.path)).toEqual([
      "README.md",
      "guides/getting-started.md",
      "images/diagram.svg",
      "index.md",
      "ventures/demo-app/decisions/0001-use-postgres.md",
      "ventures/demo-app/overview.md",
      "ventures/demo-app/roadmap/roadmap.md",
    ]);
    expect(listing.owners?.ok).toBe(true);
    expect(listing.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a document, and never a path outside the folder", async () => {
    const s = source();
    expect(await s.readDoc("guides/getting-started.md")).toMatch(/^# Getting started/);
    const backend = createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures"));
    await expect(backend.read("../package.json")).rejects.toBeInstanceOf(DocNotFoundError);
  });
});

describe("a source folder (DOCS_SOURCE_DIR) never follows symbolic links (#80)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "docs-src-"));
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "secret.md"), "# secret\n");
    writeFileSync(path.join(base, "outside", "secret.png"), "not an image");
    mkdirSync(path.join(base, "root"));
    writeFileSync(path.join(base, "root", "real.md"), "# Real\n");
    symlinkSync(path.join(base, "outside", "secret.md"), path.join(base, "root", "linked.md"));
    symlinkSync(path.join(base, "outside", "secret.png"), path.join(base, "root", "linked.png"));
    symlinkSync(path.join(base, "outside"), path.join(base, "root", "folder"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists only real files, and refuses to read through a link", async () => {
    const backend = createFixtureBackend(path.join(base, "root"));
    expect((await backend.tree()).paths).toEqual(["real.md"]);
    expect(new TextDecoder().decode(await backend.read("real.md"))).toBe("# Real\n");
    for (const p of ["linked.md", "linked.png", "folder/secret.md", "../outside/secret.md"]) {
      await expect(backend.read(p), p).rejects.toBeInstanceOf(DocNotFoundError);
    }
  });
});
