import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppManifest } from "@asafarim/app-manifest";
import { findBoundaryViolations } from "../boundaries.ts";
import { computeDrift, formatDrift } from "./drift.ts";
import {
  bytes,
  imageName,
  loadBakeTargets,
  loadCaddyHosts,
  loadCompose,
  loadManifests,
  readSiteList,
  type PlatformWiring,
} from "./load.ts";

let root: string;
function write(rel: string, content: string) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "platform-against-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loaders", () => {
  it("names images the way compose and bake do", () => {
    expect(imageName("${IMAGE_REPOSITORY:-ghcr.io/alisafari-it/asafarim-platform}:testora-${IMAGE_TAG:-local}")).toBe(
      "testora",
    );
    expect(imageName("ghcr.io/x/p:testora-runner-${IMAGE_TAG:-local}")).toBe("testora-runner");
    expect(imageName("postgres:16-alpine")).toBe("postgres");
    expect(imageName("clamav/clamav-debian:1.4")).toBe("clamav-debian");
    expect(imageName("redis")).toBe("redis");
  });

  it("compares memory sizes in bytes", () => {
    expect(bytes("512m")).toBe(536870912);
    expect(bytes("3g")).toBe(bytes(3221225472));
    expect(bytes(undefined)).toBeUndefined();
  });

  it("reads compose services, with limits from mem_limit/cpus or deploy.resources.limits", () => {
    write(
      "docker-compose.prod.yml",
      `x-args: &args { A: "1" }
services:
  web:
    image: \${IMAGE_REPOSITORY:-ghcr.io/o/r}:web-\${IMAGE_TAG:-local}
    build: { context: ., args: *args }
    networks: [asafarim_net]
  web-worker:
    image: ghcr.io/o/r:web-worker-\${IMAGE_TAG:-local}
    build: { context: ., target: worker }
    deploy: { resources: { limits: { cpus: "0.5", memory: 512m } } }
    networks: { asafarim_net: {} }
  runner:
    image: ghcr.io/o/r:runner-\${IMAGE_TAG:-local}
    mem_limit: 3g
    cpus: 2
    profiles: ["runner"]
`,
    );
    const services = loadCompose(root);
    expect(services.map((s) => [s.name, s.image, s.memory, s.cpus])).toEqual([
      ["web", "web", undefined, undefined],
      ["web-worker", "web-worker", "512m", 0.5],
      ["runner", "runner", "3g", 2],
    ]);
    expect(services[1]!.buildTarget).toBe("worker");
    expect(services[1]!.networks).toEqual(["asafarim_net"]);
  });

  it("reads bake targets and top-level Caddy sites, skipping snippets and heredocs", () => {
    write(
      "docker-bake.hcl",
      'target "_common" {\n}\ntarget "web" {\n  target = "runner"\n}\ntarget "web-worker" {\n}\n',
    );
    expect(loadBakeTargets(root)).toEqual(["web", "web-worker"]);
    write(
      "infra/caddy/Caddyfile",
      `(deploying) {
  handle_errors {
    respond <<HTML
<html><body>{not a site}</body></html>
HTML 503
  }
}

example.com, www.example.com {
  import deploying
  reverse_proxy web:3000 {
    transport http {
    }
  }
}
# comment.example.com {
https://app.example.com:443 {
  reverse_proxy app:3000
}
`,
    );
    expect(loadCaddyHosts(root)).toEqual(["example.com", "www.example.com", "app.example.com"]);
  });

  it("loads platform.app.json manifests only, never executing another checkout's code (#767)", async () => {
    const marker = path.join(root, "executed.txt");
    write("apps/notes/platform.app.json", JSON.stringify(manifest("notes")));
    write("apps/notes/platform.app.ts", "throw new Error('the .ts must not be loaded when .json exists');\n");
    write("apps/bad/platform.app.json", JSON.stringify({ ...manifest("bad"), version: "one" }));
    write(
      "apps/tsonly/platform.app.ts",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport default {};\n`,
    );
    write("apps/plain/README.md", "no manifest here");
    const loaded = await loadManifests(root);
    expect(loaded.map((m) => [m.folder, m.manifest?.id, m.problems?.[0]?.path])).toEqual([
      ["bad", undefined, "version"],
      ["notes", "notes", undefined],
      ["tsonly", undefined, ""],
    ]);
    expect(loaded.find((m) => m.folder === "tsonly")?.problems?.[0]?.message).toMatch(
      /only platform\.app\.json is read here/,
    );
    expect(existsSync(marker)).toBe(false); // the .ts-only manifest was never executed
  });

  it("reads an other-stack site list: one host per line, comments ignored", () => {
    write("other-stack-sites.txt", "# the static site on the same edge\nasafarim.be\n\nwww.asafarim.be  # alias\n");
    expect(readSiteList(path.join(root, "other-stack-sites.txt"))).toEqual(["asafarim.be", "www.asafarim.be"]);
  });
});

function manifest(id: string, extra: Partial<AppManifest> = {}): AppManifest {
  return {
    id,
    name: id.toUpperCase(),
    version: "1.0.0",
    platform: ">=0.1 <1",
    owner: "o",
    domains: { primary: `${id}.example.com` },
    runtime: { image: id, port: 3000, health: { live: "/h", ready: "/h" }, resources: { memory: "256m", cpus: 0.5 } },
    database: { engine: "none" },
    auth: { client: "none", publicPaths: [] },
    permissions: [],
    roles: [],
    ui: { glyph: "XX", color: "#000000", nav: [], status: "active" },
    ...extra,
  } as AppManifest;
}

function wiring(over: Partial<PlatformWiring> = {}): PlatformWiring {
  return {
    manifests: [{ file: "apps/web/platform.app.ts", folder: "web", manifest: manifest("web") }],
    registry: [{ key: "web", name: "WEB", glyph: "XX", status: "active" }],
    compose: [
      { name: "web", image: "web", built: true, memory: "256m", cpus: 0.5, networks: ["net"], profiles: [] },
      {
        name: "web-migrate",
        image: "web-migrate",
        buildTarget: "migrator",
        built: true,
        networks: ["net"],
        profiles: [],
      },
      { name: "postgres", image: "postgres", built: false, networks: ["net"], profiles: [] },
    ],
    bakeTargets: ["web", "web-migrate"],
    planImages: ["web", "web-migrate"],
    caddyHosts: ["web.example.com"],
    ...over,
  };
}

describe("drift", () => {
  it("lists other stacks' sites separately instead of as drift (#767)", () => {
    const w = wiring({ caddyHosts: ["web.example.com", "asafarim.be", "www.asafarim.be", "stray.example.com"] });
    const plain = computeDrift(w);
    expect(plain.unclaimed.gateway).toEqual(["asafarim.be", "www.asafarim.be", "stray.example.com"]);
    const report = computeDrift(w, { otherStackSites: ["asafarim.be", "www.asafarim.be"] });
    expect(report.unclaimed.gateway).toEqual(["stray.example.com"]);
    expect(report.otherStack).toEqual(["asafarim.be", "www.asafarim.be"]);
    expect(formatDrift(report)).toContain("Other stacks on the same edge (not drift): asafarim.be, www.asafarim.be");
    const onlyOther = computeDrift(wiring({ caddyHosts: ["web.example.com", "asafarim.be"] }), {
      otherStackSites: ["asafarim.be"],
    });
    expect(onlyOther.ok).toBe(true);
  });

  it("reports no drift when every place agrees (jobs and platform services claimed)", () => {
    const report = computeDrift(wiring());
    expect(report.ok).toBe(true);
    expect(report.platformServices).toEqual(["postgres"]);
    expect(formatDrift(report).at(-1)).toBe("No drift.");
  });

  it("reports registry, limit, bake, plan and gateway disagreements", () => {
    const report = computeDrift(
      wiring({
        registry: [{ key: "web", name: "Web site", glyph: "WB", status: "coming-soon" }],
        compose: [{ name: "web", image: "web", built: true, networks: [], profiles: [] }],
        bakeTargets: [],
        planImages: [],
        caddyHosts: [],
      }),
    );
    const web = report.apps[0]!;
    expect(web.areas.registry).toEqual([
      'name "Web site" ≠ manifest "WEB"',
      'glyph "WB" ≠ manifest "XX"',
      'status "coming-soon" ≠ manifest "active"',
    ]);
    expect(web.areas.compose).toEqual([
      "web: no mem_limit in compose (manifest: 256m)",
      "web: no cpus in compose (manifest: 0.5)",
    ]);
    expect(web.areas.bake).toEqual(['no bake target "web"']);
    expect(web.areas.plan).toEqual(['no build-plan image "web"']);
    expect(web.areas.gateway).toEqual(["no site for web.example.com"]);
    expect(report.ok).toBe(false);
  });

  it("lists what no manifest claims, in every area", () => {
    const report = computeDrift(
      wiring({
        registry: [
          { key: "web", name: "WEB", glyph: "XX", status: "active" },
          { key: "devtools", name: "D", glyph: "DT", status: "active" },
        ],
        caddyHosts: ["web.example.com", "other.example.com"],
        compose: [
          ...wiring().compose,
          { name: "clamav", image: "clamav-debian", built: false, networks: [], profiles: [] },
        ],
      }),
    );
    expect(report.unclaimed).toMatchObject({
      registry: ["devtools"],
      compose: ["clamav"],
      gateway: ["other.example.com"],
    });
    expect(report.ok).toBe(false);
  });

  it("checks workers: service, limits, and egress-only off the platform network", () => {
    const m = manifest("testora", {
      runtime: {
        image: "testora",
        port: 3000,
        health: { live: "/h", ready: "/h" },
        resources: { memory: "256m", cpus: 0.5 },
        workers: [
          {
            name: "runner",
            image: "testora-runner",
            network: "egress-only",
            resources: { memory: "3g", cpus: 2 },
          },
        ],
      },
    });
    const base = {
      manifests: [{ file: "apps/testora/platform.app.ts", folder: "testora", manifest: m }],
      registry: [{ key: "testora", name: "TESTORA", glyph: "XX", status: "active" }],
      bakeTargets: ["testora", "testora-runner"],
      planImages: ["testora", "testora-runner"],
      caddyHosts: ["testora.example.com"],
    };
    const ok = computeDrift({
      ...base,
      compose: [
        {
          name: "testora",
          image: "testora",
          built: true,
          memory: "256m",
          cpus: 0.5,
          networks: ["net", "control"],
          profiles: [],
        },
        {
          name: "testora-runner",
          image: "testora-runner",
          built: true,
          memory: "3g",
          cpus: 2,
          networks: ["control", "egress"],
          profiles: [],
        },
        { name: "postgres", image: "postgres", built: false, networks: ["net"], profiles: [] },
      ],
    });
    expect(ok.ok).toBe(true);
    const leaky = computeDrift({
      ...base,
      compose: [
        { name: "testora", image: "testora", built: true, memory: "256m", cpus: 0.5, networks: ["net"], profiles: [] },
        {
          name: "testora-runner",
          image: "testora-runner",
          built: true,
          memory: "2g",
          cpus: 2,
          networks: ["net"],
          profiles: [],
        },
        { name: "postgres", image: "postgres", built: false, networks: ["net"], profiles: [] },
      ],
    });
    expect(leaky.apps[0]!.areas.compose).toEqual([
      "testora-runner: mem_limit 2g ≠ manifest 3g",
      "testora-runner: egress-only worker is on the platform network net",
    ]);
  });

  it("checks the dedicated database container both ways", () => {
    const dedicated = manifest("web", { database: { engine: "postgres", migrations: "drizzle", dedicated: true } });
    const missing = computeDrift(wiring({ manifests: [{ file: "f", folder: "web", manifest: dedicated }] }));
    expect(missing.apps[0]!.areas.compose).toContain('database.dedicated, but no service "web-postgres"');
    const extra = computeDrift(
      wiring({
        compose: [
          ...wiring().compose,
          { name: "web-postgres", image: "postgres", built: false, networks: [], profiles: [] },
        ],
      }),
    );
    expect(extra.apps[0]!.areas.compose).toContain(
      `service "web-postgres" exists, but the manifest doesn't declare a dedicated database`,
    );
  });

  it("shows an invalid manifest as such and compares nothing for it", () => {
    const report = computeDrift(
      wiring({
        manifests: [
          { file: "apps/web/platform.app.json", folder: "web", problems: [{ path: "version", message: "bad" }] },
        ],
      }),
    );
    expect(report.apps[0]!.invalid).toEqual(["version: bad"]);
    expect(formatDrift(report).join("\n")).toContain("✖ invalid manifest — version: bad");
  });
});

describe("boundaries", () => {
  it("flags core and package code that imports from apps/, by path or package name", () => {
    write("apps/notes/package.json", JSON.stringify({ name: "@asafarim/notes" }));
    write("apps/notes/src/index.ts", "export const x = 1;\n");
    write(
      "packages/sdk/src/ok.ts",
      'import { z } from "zod";\nimport type { A } from "../../app-manifest/src/index.ts";\n',
    );
    write(
      "core/api/src/bad.ts",
      [
        'import { x } from "../../../apps/notes/src/index.ts";',
        'export { y } from "@asafarim/notes/feature";',
        'const m = await import("@asafarim/notes");',
        'const r = require("../../../apps/notes");',
      ].join("\n"),
    );
    expect(findBoundaryViolations(root)).toEqual([
      { file: "core/api/src/bad.ts", line: 1, specifier: "../../../apps/notes/src/index.ts" },
      { file: "core/api/src/bad.ts", line: 2, specifier: "@asafarim/notes/feature" },
      { file: "core/api/src/bad.ts", line: 3, specifier: "@asafarim/notes" },
      { file: "core/api/src/bad.ts", line: 4, specifier: "../../../apps/notes" },
    ]);
  });
});
