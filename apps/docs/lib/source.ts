import "server-only";
/**
 * Where the documents come from (#78): the configured source repository, read at runtime through
 * GitHub's API with a read-only token (DOCS_GITHUB_TOKEN). Nothing is copied into the code or the
 * image. Without a token, local development reads the fake fixtures in `apps/docs/fixtures/`; in
 * production there is then nothing to read, and the app says "Documents temporarily unavailable".
 *
 * Results are cached in memory: the tree for 5 minutes, files keyed by the tree's sha (so a new
 * commit means new keys). `refresh()` drops everything. The token never leaves this module: it isn't
 * logged, isn't in an error message, and `server-only` keeps this file out of browser bundles.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseOwnersConfig, type ParsedOwners } from "./owners";

export const OWNERS_FILE = "docs-app.json";
const DOC_EXT = /\.md$/i;
const IMAGE_EXT = /\.(png|jpe?g|svg)$/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

export type EntryKind = "doc" | "image";
export interface DocEntry {
  path: string;
  kind: EntryKind;
}

export interface Listing {
  /** The tree's sha (GitHub) or a digest of the fixture files: changes whenever the content does. */
  sha: string;
  entries: DocEntry[];
  /** The parsed docs-app.json; null when the source has none. */
  owners: ParsedOwners | null;
}

/** GitHub (or the fixture folder) can't be read right now. Safe to show: never contains the token. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

/** The path isn't a document or image of the current listing. */
export class DocNotFoundError extends Error {
  constructor(p: string) {
    super(`not found: ${p}`);
    this.name = "DocNotFoundError";
  }
}

/** The raw access to a source; `createSource` adds the listing rules and the cache. */
export interface SourceBackend {
  readonly mode: "github" | "fixtures" | "none";
  tree(): Promise<{ sha: string; paths: string[] }>;
  read(filePath: string): Promise<Uint8Array<ArrayBuffer>>;
}

export function kindOf(p: string): EntryKind | undefined {
  if (DOC_EXT.test(p)) return "doc";
  if (IMAGE_EXT.test(p)) return "image";
  return undefined;
}

/** GitHub's REST API with a fine-grained token (Contents: read on the source repo only). */
export function createGitHubBackend(opts: {
  repo: string;
  branch: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SourceBackend {
  if (!REPO.test(opts.repo)) throw new Error("source.repo must be owner/name");
  if (!BRANCH.test(opts.branch)) throw new Error("source.branch isn't a valid branch name");
  const fetchFn = opts.fetch ?? fetch;
  const api = `https://api.github.com/repos/${opts.repo}`;
  const headers = (accept: string) => ({
    accept,
    authorization: `Bearer ${opts.token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "asafarim-docs",
  });

  async function get(url: string, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: headers(accept), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    } catch {
      throw new SourceUnavailableError("GitHub isn't reachable");
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new DocNotFoundError(url.slice(api.length));
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new SourceUnavailableError(`GitHub answered ${res.status}`);
    }
    return res;
  }

  return {
    mode: "github",
    async tree() {
      const res = await get(
        `${api}/git/trees/${encodeURIComponent(opts.branch)}?recursive=1`,
        "application/vnd.github+json",
      );
      const body = (await res.json()) as { sha?: string; tree?: { path?: string; type?: string }[] };
      if (typeof body.sha !== "string" || !Array.isArray(body.tree)) {
        throw new SourceUnavailableError("GitHub's answer wasn't a tree");
      }
      const paths = body.tree.filter((t) => t.type === "blob" && typeof t.path === "string").map((t) => t.path!);
      return { sha: body.sha, paths };
    },
    async read(filePath) {
      const encoded = filePath.split("/").map(encodeURIComponent).join("/");
      const res = await get(
        `${api}/contents/${encoded}?ref=${encodeURIComponent(opts.branch)}`,
        "application/vnd.github.raw+json",
      );
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** The fake documents in a local folder (development, tests). Paths never leave `dir`. */
export function createFixtureBackend(dir: string): SourceBackend {
  const root = path.resolve(dir);
  return {
    mode: "fixtures",
    async tree() {
      // Only real files and folders: a symbolic link (to a file or a folder) is never listed or
      // descended into, so nothing outside the folder is reachable through one (DOCS_SOURCE_DIR works
      // in a production build).
      const names: string[] = [];
      const walk = async (rel: string): Promise<void> => {
        for (const d of await readdir(path.join(root, rel), { withFileTypes: true })) {
          const name = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) await walk(name);
          else if (d.isFile()) names.push(name);
        }
      };
      try {
        await walk("");
      } catch {
        throw new SourceUnavailableError("the fixture folder can't be read");
      }
      const files: string[] = [];
      const digest = createHash("sha256");
      for (const name of names.sort()) {
        const s = await lstat(path.join(root, name));
        if (!s.isFile()) continue;
        files.push(name);
        digest.update(`${name}\0${s.size}\0${s.mtimeMs}\n`);
      }
      return { sha: digest.digest("hex").slice(0, 40), paths: files };
    },
    async read(filePath) {
      const full = path.resolve(root, filePath);
      if (!full.startsWith(root + path.sep)) throw new DocNotFoundError(filePath);
      try {
        // The real path (any linked folder on the way resolved) must still be inside the real root,
        // and the file itself must not be a link.
        const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
        if (!realFull.startsWith(realRoot + path.sep) || (await lstat(full)).isSymbolicLink()) {
          throw new DocNotFoundError(filePath);
        }
        return new Uint8Array(await readFile(realFull));
      } catch {
        throw new DocNotFoundError(filePath);
      }
    },
  };
}

/** No token outside development: nothing to read. */
export function createUnavailableBackend(reason: string): SourceBackend {
  const fail = async (): Promise<never> => {
    throw new SourceUnavailableError(reason);
  };
  return { mode: "none", tree: fail, read: fail };
}

export const CACHE_TTL_MS = 5 * 60 * 1000;

export function createSource(backend: SourceBackend, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  let listing: { at: number; value: Promise<Listing> } | undefined;
  /** File contents by `<sha>:<path>`; dropped when the sha changes or on refresh. */
  let files = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  let filesSha: string | undefined;

  async function load(): Promise<Listing> {
    // The tree or docs-app.json answering 404 means the repo, branch or token is wrong (GitHub answers
    // 404 for a repo the token can't see): the documents are unavailable, it isn't a server error.
    const { sha, paths } = await backend.tree().catch((err: unknown) => {
      throw err instanceof DocNotFoundError ? new SourceUnavailableError("the source repository can't be found") : err;
    });
    const entries: DocEntry[] = [];
    for (const p of paths) {
      const kind = kindOf(p);
      if (kind) entries.push({ path: p, kind });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let owners: ParsedOwners | null = null;
    if (paths.includes(OWNERS_FILE)) {
      try {
        owners = parseOwnersConfig(new TextDecoder().decode(await backend.read(OWNERS_FILE)));
      } catch (err) {
        if (err instanceof SourceUnavailableError) throw err;
        if (err instanceof DocNotFoundError) throw new SourceUnavailableError(`${OWNERS_FILE} can't be found`);
        owners = { ok: false, error: `${OWNERS_FILE} can't be read` };
      }
    }
    return { sha, entries, owners };
  }

  function listDocs(): Promise<Listing> {
    if (!listing || now() - listing.at >= ttl) {
      const entry = { at: now(), value: load() };
      listing = entry;
      // A failed load isn't cached: the next request tries again.
      entry.value.catch(() => {
        if (listing === entry) listing = undefined;
      });
    }
    return listing.value;
  }

  async function readFile(p: string, kind: EntryKind): Promise<Uint8Array<ArrayBuffer>> {
    const current = await listDocs();
    if (!current.entries.some((e) => e.path === p && e.kind === kind)) throw new DocNotFoundError(p);
    if (filesSha !== current.sha) {
      files = new Map();
      filesSha = current.sha;
    }
    const key = `${current.sha}:${p}`;
    let hit = files.get(key);
    if (!hit) {
      hit = backend.read(p);
      files.set(key, hit);
      hit.catch(() => files.delete(key));
    }
    return hit;
  }

  return {
    mode: backend.mode,
    listDocs,
    /** A document's Markdown. Only paths in the current listing can be read. */
    readDoc: async (p: string) => new TextDecoder().decode(await readFile(p, "doc")),
    /** An image's bytes. Only images in the current listing can be read. */
    readImage: (p: string) => readFile(p, "image"),
    /** The Refresh button: forget the tree and every file. */
    refresh() {
      listing = undefined;
      files = new Map();
      filesSha = undefined;
    },
  };
}

export type DocSource = ReturnType<typeof createSource>;

/**
 * The app's source, one per server process: GitHub when DOCS_GITHUB_TOKEN is set (the secret the
 * manifest names), else a local folder named by DOCS_SOURCE_DIR (the e2e run points it at the
 * fixtures of a production build), else the fixtures in development, else nothing.
 */
export function getSource(config: { repo: string; branch: string }): DocSource {
  const g = globalThis as unknown as { docsSource?: DocSource };
  if (!g.docsSource) {
    const token = process.env.DOCS_GITHUB_TOKEN;
    const dir = process.env.DOCS_SOURCE_DIR;
    const backend = token
      ? createGitHubBackend({ ...config, token })
      : dir
        ? createFixtureBackend(path.resolve(dir))
        : process.env.NODE_ENV !== "production"
          ? createFixtureBackend(path.join(process.cwd(), "fixtures"))
          : createUnavailableBackend("no source token is configured");
    g.docsSource = createSource(backend);
  }
  return g.docsSource;
}
