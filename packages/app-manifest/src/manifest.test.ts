import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSchema, SCHEMA_FILE } from "../scripts/write-schema.ts";
import {
  ManifestError,
  defaultHost,
  defineApp,
  formatPath,
  launcherEntries,
  validateManifest,
  type AppManifestInput,
  type ManifestProblem,
} from "./index.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "fixtures", name), "utf8")) as AppManifestInput;

const minimal = () => fixture("minimal.platform.app.json");
const testora = () => fixture("testora.platform.app.json");

/** Validate and return the problems (the test fails if the manifest is valid). */
function problems(input: unknown): ManifestProblem[] {
  const result = validateManifest(input);
  if (result.ok) throw new Error("expected the manifest to be invalid");
  return result.problems;
}

function expectProblem(input: unknown, at: string, message: RegExp) {
  const found = problems(input);
  expect(found, JSON.stringify(found, null, 2)).toContainEqual({ path: at, message: expect.stringMatching(message) });
}

describe("golden manifests", () => {
  it("accepts the minimal manifest unchanged", () => {
    const result = validateManifest(minimal());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toEqual(minimal());
  });

  it("accepts Testora's full manifest unchanged", () => {
    const result = validateManifest(testora());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest).toEqual(testora());
      expect(result.manifest.permissions.map((p) => p.key)).toEqual([
        "testora.results.read",
        "testora.tests.run",
        "testora.issues.report",
        "testora.catalog.manage",
      ]);
      expect(result.manifest.roles.map((r) => r.key)).toEqual(["testora.member", "testora.tester", "testora.admin"]);
    }
  });

  it("defineApp returns the manifest, and throws a ManifestError with the field paths", () => {
    expect(defineApp(testora()).id).toBe("testora");
    const broken = { ...testora(), version: "1.8" };
    expect(() => defineApp(broken)).toThrow(ManifestError);
    expect(() => defineApp(broken)).toThrow(/version: must be a semver version/);
  });
});

describe("id, version, platform", () => {
  it("refuses a non-kebab or reserved id", () => {
    expectProblem({ ...minimal(), id: "Notes_App" }, "id", /kebab-case/);
    expectProblem({ ...minimal(), id: "admin" }, "id", /reserved/);
    expectProblem({ ...minimal(), id: "core" }, "id", /reserved/);
  });

  it("refuses a non-semver version and an invalid platform range", () => {
    expectProblem({ ...minimal(), version: "v1.0.0" }, "version", /semver/);
    expectProblem({ ...minimal(), platform: "one point oh" }, "platform", /semver range/);
  });

  it("refuses unknown fields (typos don't pass silently)", () => {
    expectProblem({ ...minimal(), permision: [] }, "", /Unrecognized key/i);
  });
});

describe("runtime", () => {
  it("requires a resources block on the app", () => {
    const m = minimal();
    const { resources: _drop, ...runtime } = m.runtime;
    expectProblem({ ...m, runtime }, "runtime.resources", /is required/);
  });

  it("requires resources on workers too, and a known worker network", () => {
    const m = testora();
    const w = m.runtime.workers![0]!;
    const { resources: _drop, ...noResources } = w;
    expectProblem(
      { ...m, runtime: { ...m.runtime, workers: [noResources] } },
      "runtime.workers[0].resources",
      /is required/,
    );
    expectProblem(
      { ...m, runtime: { ...m.runtime, workers: [{ ...w, network: "public" }] } },
      "runtime.workers[0].network",
      /internal|egress-only/,
    );
  });

  it("refuses a malformed memory size", () => {
    const m = minimal();
    expectProblem(
      { ...m, runtime: { ...m.runtime, resources: { memory: "512MB", cpus: 0.5 } } },
      "runtime.resources.memory",
      /memory size/,
    );
  });
});

describe("database", () => {
  it("needs a migrations tool for postgres, and none for engine 'none'", () => {
    expectProblem({ ...minimal(), database: { engine: "postgres" } }, "database.migrations", /drizzle|prisma|sql/);
    expectProblem({ ...minimal(), database: { engine: "none", migrations: "sql" } }, "database", /Unrecognized key/i);
  });
});

describe("namespace rule", () => {
  it("refuses a permission outside the app's namespace", () => {
    const m = testora();
    expectProblem(
      { ...m, permissions: [...m.permissions, { key: "tasksai.tasks.write", description: "x" }] },
      "permissions[4].key",
      /own namespace "testora\.\*"/,
    );
  });

  it("refuses a role outside the namespace, or granting another app's permission", () => {
    const m = testora();
    expectProblem({ ...m, roles: [{ key: "hub.admin", grants: ["testora.*"] }] }, "roles[0].key", /own namespace/);
    expectProblem(
      { ...m, roles: [{ key: "testora.tester", grants: ["hub.users.manage"] }] },
      "roles[0].grants[0]",
      /outside the app's own namespace/,
    );
    expectProblem(
      { ...m, roles: [{ key: "testora.tester", grants: ["testora.catalog.delete"] }] },
      "roles[0].grants[0]",
      /isn't declared in permissions/,
    );
    // Another app's wildcard is still a namespace escape.
    expectProblem({ ...m, roles: [{ key: "testora.x", grants: ["tasksai.*"] }] }, "roles[0].grants[0]", /outside/);
  });

  it("refuses publishing another app's event type, but allows subscribing to one", () => {
    const m = testora();
    expectProblem(
      { ...m, events: { publishes: [{ type: "tasksai.task.created.v1", schema: "./events/x.json" }] } },
      "events.publishes[0].type",
      /own namespace/,
    );
    expect(validateManifest(m).ok).toBe(true); // subscribes to tasksai.feature.decomposed.v1
  });

  it("refuses a malformed event type", () => {
    const m = testora();
    expectProblem(
      { ...m, events: { publishes: [{ type: "testora.runCompleted", schema: "./e.json" }] } },
      "events.publishes[0].type",
      /<app>\.<entity>\.<verb>\.v<N>/,
    );
  });
});

describe("routes", () => {
  it("refuses a route permission that isn't declared", () => {
    const m = testora();
    expectProblem(
      { ...m, routes: [{ path: "/api/admin/**", permission: "testora.admin.everything" }] },
      "routes[0].permission",
      /isn't declared/,
    );
  });

  it("refuses a permission on a route that is never exposed", () => {
    const m = testora();
    expectProblem(
      { ...m, routes: [{ path: "/internal/**", expose: false, permission: "testora.tests.run" }] },
      "routes[0].permission",
      /expose: false/,
    );
  });
});

describe("ui.launcher", () => {
  const launcher = { description: "Write, run and report tests.", meta: "testora", access: "public", order: 60 };
  const withLauncher = (extra: Record<string, unknown> = {}) => {
    const m = minimal();
    return { ...m, ui: { ...m.ui, launcher: { ...launcher, ...extra } } };
  };

  it("is optional, and accepted with or without requiresAccountToUse", () => {
    expect(validateManifest(minimal()).ok).toBe(true);
    expect(validateManifest(withLauncher()).ok).toBe(true);
    expect(validateManifest(withLauncher({ requiresAccountToUse: true })).ok).toBe(true);
  });

  it("refuses an unknown access level, a negative order and unknown fields", () => {
    expectProblem(withLauncher({ access: "admins" }), "ui.launcher.access", /./);
    expectProblem(withLauncher({ order: -1 }), "ui.launcher.order", /./);
    expect(problems(withLauncher({ showcase: true })).length).toBeGreaterThan(0);
  });
});

describe("secrets", () => {
  it("accepts environment variable names only", () => {
    expect(validateManifest({ ...minimal(), secrets: ["GITHUB_TOKEN", "DB_PASSWORD_2"] }).ok).toBe(true);
  });

  it("refuses anything that looks like a value", () => {
    for (const value of [
      "postgres://app:example@db:5432/notes",
      "GITHUB_TOKEN=abc123",
      "ab12cd34ef56gh78ij90kl12",
      "a secret with spaces",
    ]) {
      expectProblem({ ...minimal(), secrets: [value] }, "secrets[0]", /looks like a secret value/);
    }
    expectProblem({ ...minimal(), secrets: ["github_token"] }, "secrets[0]", /UPPER_SNAKE_CASE/);
  });
});

describe("config, domains, ui and duplicates", () => {
  it("checks a config default against its type", () => {
    expectProblem(
      { ...minimal(), config: [{ key: "runs.max", type: "int", default: 2.5 }] },
      "config[0].default",
      /int/,
    );
    expectProblem(
      { ...minimal(), config: [{ key: "flag", type: "boolean", default: "yes" }] },
      "config[0].default",
      /boolean/,
    );
  });

  it("refuses duplicates", () => {
    const m = testora();
    expectProblem(
      { ...m, permissions: [...m.permissions, m.permissions[0]!] },
      "permissions[4].key",
      /duplicate permission/,
    );
    expectProblem({ ...m, secrets: ["GITHUB_TOKEN", "GITHUB_TOKEN"] }, "secrets[1]", /duplicate secret/);
  });

  it("refuses an alias equal to the primary domain and malformed hosts", () => {
    const m = testora();
    expectProblem(
      { ...m, domains: { primary: "testora.cloud", aliases: ["testora.cloud"] } },
      "domains.aliases",
      /primary/,
    );
    expectProblem({ ...m, domains: { primary: "https://testora.cloud" } }, "domains.primary", /hostname/);
  });

  it("checks the UI block", () => {
    const m = minimal();
    expectProblem({ ...m, ui: { ...m.ui, color: "purple" } }, "ui.color", /hex colour/);
    expectProblem({ ...m, ui: { ...m.ui, status: "beta" } }, "ui.status", /active|coming-soon/);
  });

  it("reports every problem of an invalid file, each with its field path", () => {
    const found = problems(fixture("invalid.platform.app.json")).map((p) => p.path);
    expect(found).toEqual(
      expect.arrayContaining([
        "version",
        "runtime.resources",
        "permissions[1].key",
        "roles[0].grants[1]",
        "routes[0].permission",
        "events.publishes[0].type",
        "secrets[1]",
      ]),
    );
  });
});

describe("helpers and the JSON Schema", () => {
  it("formats field paths and the default host", () => {
    expect(formatPath(["roles", 1, "grants", 0])).toBe("roles[1].grants[0]");
    expect(formatPath([])).toBe("");
    expect(defaultHost("testora")).toBe("testora.asafarim.site");
  });

  it("ships an up-to-date JSON Schema (run `pnpm --filter @asafarim/app-manifest schema`)", () => {
    expect(readFileSync(SCHEMA_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(renderSchema());
  });

  it("puts the reserved ids and the secret-name pattern into the JSON Schema", () => {
    const schema = JSON.parse(renderSchema()) as {
      properties: { id: { not: { enum: string[] } }; secrets: { items: { pattern: string } } };
      additionalProperties: boolean;
    };
    expect(schema.properties.id.not.enum).toContain("admin");
    expect(new RegExp(schema.properties.secrets.items.pattern).test("GITHUB_TOKEN")).toBe(true);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("launcherEntries (shared by `platform sync` and core-api)", () => {
  const withLauncher = (id: string, order: number, extra: object = {}) => {
    const m = validateManifest({
      ...minimal(),
      id,
      name: id.toUpperCase(),
      permissions: [],
      roles: [],
      ui: {
        glyph: "XX",
        color: "#000000",
        nav: [],
        status: "active",
        launcher: { description: "d", meta: "m", access: "authenticated", order, ...extra },
      },
    });
    if (!m.ok) throw new Error(JSON.stringify(m.problems));
    return m.manifest;
  };

  it("keeps only manifests with a launcher block, ordered by `order` then id (code-unit order)", () => {
    const quiet = {
      ...withLauncher("quiet", 1),
      ui: { glyph: "QQ", color: "#000000", nav: [], status: "active" as const },
    };
    const list = launcherEntries([withLauncher("zeta", 5), withLauncher("beta", 10), withLauncher("alpha", 10), quiet]);
    expect(list.map((e) => e.key)).toEqual(["zeta", "alpha", "beta"]);
  });

  it("projects exactly the tile fields, and requiresAccountToUse only when declared", () => {
    const [plain, flagged] = launcherEntries([
      withLauncher("aa", 1),
      withLauncher("bb", 2, { requiresAccountToUse: true }),
    ]);
    expect(plain).toEqual({
      key: "aa",
      name: "AA",
      description: "d",
      glyph: "XX",
      meta: "m",
      status: "active",
      access: "authenticated",
      order: 1,
    });
    expect(flagged).toMatchObject({ requiresAccountToUse: true });
  });

  it("copes with a built-in app that has no `ui` at all (core's own row)", () => {
    expect(launcherEntries([{ id: "core", name: "Core" } as never])).toEqual([]);
  });
});
