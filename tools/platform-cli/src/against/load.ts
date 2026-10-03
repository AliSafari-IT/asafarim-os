/**
 * Read the hand-written wiring of an existing platform checkout (today:
 * asafarim-platform) into plain data, so `drift.ts` can compare it with the
 * app manifests. Read-only: nothing here writes to the checkout.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateManifest, type AppManifest, type ManifestProblem } from "@asafarim/app-manifest";
import { loadManifestFile } from "../manifest.ts";

export interface RegistryEntry {
  key: string;
  name: string;
  glyph: string;
  status: string;
}

export interface ComposeService {
  name: string;
  /** Last path segment of the image name, without registry or tag. */
  image: string;
  /** The bake/Dockerfile target, when the service is built here. */
  buildTarget?: string;
  /** The service has a `build:` section, so its image is built from this repo. */
  built: boolean;
  memory?: string;
  cpus?: number;
  networks: string[];
  profiles: string[];
}

export interface LoadedManifest {
  /** `apps/<folder>/platform.app.(ts|json)`, relative to the checkout. */
  file: string;
  folder: string;
  manifest?: AppManifest;
  problems?: ManifestProblem[];
}

export interface PlatformWiring {
  manifests: LoadedManifest[];
  registry: RegistryEntry[];
  compose: ComposeService[];
  bakeTargets: string[];
  planImages: string[];
  caddyHosts: string[];
}

const posix = (p: string) => p.split(path.sep).join("/");

/** `apps/<folder>/platform.app.ts`, or `.json` when there's no .ts. */
export async function loadManifests(root: string): Promise<LoadedManifest[]> {
  const appsDir = path.join(root, "apps");
  if (!existsSync(appsDir)) return [];
  const out: LoadedManifest[] = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const file = ["platform.app.ts", "platform.app.json"]
      .map((f) => path.join(appsDir, entry.name, f))
      .find((f) => existsSync(f));
    if (!file) continue;
    const rel = posix(path.relative(root, file));
    try {
      const result = validateManifest(await loadManifestFile(file));
      out.push(
        result.ok
          ? { file: rel, folder: entry.name, manifest: result.manifest }
          : { file: rel, folder: entry.name, problems: result.problems },
      );
    } catch (error) {
      out.push({ file: rel, folder: entry.name, problems: [{ path: "", message: (error as Error).message }] });
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** The launcher registry (`PLATFORM_APPS` in packages/auth/src/apps.ts). */
export async function loadRegistry(root: string): Promise<RegistryEntry[]> {
  const file = path.join(root, "packages", "auth", "src", "apps.ts");
  const mod = (await import(pathToFileURL(file).href)) as { PLATFORM_APPS?: RegistryEntry[] };
  if (!Array.isArray(mod.PLATFORM_APPS))
    throw new Error(`${posix(path.relative(root, file))} exports no PLATFORM_APPS`);
  return mod.PLATFORM_APPS.map(({ key, name, glyph, status }) => ({ key, name, glyph, status }));
}

/** Image name → its last path segment without tag or `${…}` suffixes: `ghcr.io/x/p:testora-${IMAGE_TAG}` → `testora`. */
export function imageName(image: string): string {
  const repoTag = image.split("/").pop() ?? image;
  const colon = repoTag.indexOf(":");
  if (colon === -1) return repoTag;
  const repo = repoTag.slice(0, colon);
  const tag = repoTag.slice(colon + 1);
  // Our own images are one repository whose tag carries the image name: `<repo>:<image>-${IMAGE_TAG}`.
  const own = /^([a-z0-9-]+?)-\$\{IMAGE_TAG/.exec(tag);
  return own ? own[1]! : repo;
}

/** Docker size (`3g`, `536870912`) → a comparable number of bytes. */
export function bytes(size: string | number | undefined): number | undefined {
  if (size === undefined) return undefined;
  if (typeof size === "number") return size;
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(size.trim());
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  return Math.round(Number(m[1]) * unit);
}

interface RawService {
  image?: string;
  build?: { target?: string; context?: string };
  mem_limit?: string | number;
  cpus?: number | string;
  deploy?: { resources?: { limits?: { memory?: string | number; cpus?: number | string } } };
  networks?: string[] | Record<string, unknown>;
  profiles?: string[];
}

export function loadCompose(root: string, file = "docker-compose.prod.yml"): ComposeService[] {
  const doc = parseYaml(readFileSync(path.join(root, file), "utf8")) as { services?: Record<string, RawService> };
  return Object.entries(doc.services ?? {}).map(([name, s]) => {
    // Compose honours both spellings; `mem_limit`/`cpus` win when both are set.
    const memory = s.mem_limit ?? s.deploy?.resources?.limits?.memory;
    const cpus = s.cpus ?? s.deploy?.resources?.limits?.cpus;
    return {
      name,
      image: imageName(s.image ?? name),
      buildTarget: s.build?.target,
      built: s.build !== undefined,
      memory: memory === undefined ? undefined : String(memory),
      cpus: cpus === undefined ? undefined : Number(cpus),
      networks: Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}),
      profiles: s.profiles ?? [],
    };
  });
}

/** Target names in docker-bake.hcl (`target "<name>" {`), excluding `_`-prefixed bases. */
export function loadBakeTargets(root: string): string[] {
  const hcl = readFileSync(path.join(root, "docker-bake.hcl"), "utf8");
  return [...hcl.matchAll(/^target\s+"([^"]+)"\s*\{/gm)].map((m) => m[1]!).filter((t) => !t.startsWith("_"));
}

/** `IMAGES[].image` from scripts/plan-image-builds.mjs (the per-push build plan). */
export async function loadPlanImages(root: string): Promise<string[]> {
  const file = path.join(root, "scripts", "plan-image-builds.mjs");
  const mod = (await import(pathToFileURL(file).href)) as { IMAGES?: { image: string }[] };
  return (mod.IMAGES ?? []).map((i) => i.image);
}

/** Site addresses at the top level of the Caddyfile (snippets like `(name)` excluded). */
export function loadCaddyHosts(root: string, file = path.join("infra", "caddy", "Caddyfile")): string[] {
  const text = readFileSync(path.join(root, file), "utf8");
  const hosts: string[] = [];
  let depth = 0;
  let inHeredoc: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (inHeredoc) {
      if (line.startsWith(inHeredoc)) inHeredoc = null;
      continue;
    }
    const heredoc = /<<([A-Z]+)\s*$/.exec(line);
    if (heredoc) {
      inHeredoc = heredoc[1]!;
      continue;
    }
    if (depth === 0 && line.endsWith("{") && !line.startsWith("(")) {
      for (const addr of line
        .slice(0, -1)
        .split(/[\s,]+/)
        .filter(Boolean)) {
        hosts.push(addr.replace(/^https?:\/\//, "").replace(/:\d+$/, ""));
      }
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return hosts.filter((h) => h.length > 0);
}

export async function loadPlatformWiring(root: string): Promise<PlatformWiring> {
  return {
    manifests: await loadManifests(root),
    registry: await loadRegistry(root),
    compose: loadCompose(root),
    bakeTargets: loadBakeTargets(root),
    planImages: await loadPlanImages(root),
    caddyHosts: loadCaddyHosts(root),
  };
}
