import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest, type AppManifest } from "@asafarim/app-manifest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  COMPOSE_HELP,
  buildCompose,
  composeCommand,
  isPinnedImage,
  parseComposeArgs,
  type ComposeOptions,
} from "./compose.ts";
import { fakeDocker } from "./fake-docker.ts";

const fixtures = path.resolve(import.meta.dirname, "..", "fixtures");
const load = (rel: string): AppManifest => {
  const result = validateManifest(JSON.parse(readFileSync(path.join(fixtures, rel, "platform.app.json"), "utf8")));
  if (!result.ok) throw new Error(`fixture ${rel} is invalid`);
  return result.manifest;
};
const IGS = load("igs-shaped");
const EXT = load("external-app");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const WEB = `ghcr.io/alisafari-it/igs-pharma-web:${SHA}`;
const igsOptions = (extra: Partial<ComposeOptions> = {}): ComposeOptions => ({ env: "staging", image: WEB, ...extra });
const extOptions = (extra: Partial<ComposeOptions> = {}): ComposeOptions => ({
  env: "prod",
  image: `ghcr.io/example/ext-demo@${DIGEST}`,
  workerImages: { jobs: `ghcr.io/example/ext-demo-jobs@${DIGEST}` },
  migrateCommand: ["/app/migrate"],
  ...extra,
});

function built(manifest: AppManifest, options: ComposeOptions) {
  const result = buildCompose(manifest, options);
  if (!result.ok) throw new Error(result.lines.join("\n"));
  return result.file;
}
const services = (yaml: string) => (parse(yaml) as { services: Record<string, Record<string, unknown>> }).services;

describe("isPinnedImage", () => {
  it.each([
    [`ghcr.io/a/b@${DIGEST}`, true],
    [`b@${DIGEST}`, true],
    [`ghcr.io/a/b:${SHA}`, true],
    [`ghcr.io:5000/a/b:${SHA}`, true],
    [`ghcr.io/a/b:${SHA}@${DIGEST}`, true],
    ["ghcr.io/a/b:latest", false],
    ["ghcr.io/a/b:v1.2.3", false],
    ["ghcr.io/a/b:main", false],
    ["ghcr.io/a/b", false],
    ["b", false],
    [`ghcr.io/a/b:${SHA.slice(1)}`, false],
    [`ghcr.io/a/b:${SHA}0`, false],
    [`ghcr.io/a/b:${SHA.toUpperCase()}`, false],
    ["ghcr.io/a/b@sha256:abc", false],
  ])("%s → %s", (ref, pinned) => expect(isPinnedImage(ref)).toBe(pinned));
});

describe("the generated file", () => {
  it("matches the snapshot for an IGS-shaped app (web, worker, database, two secrets)", () => {
    expect(built(IGS, igsOptions()).yaml).toMatchSnapshot();
  });

  it("matches the snapshot for the ext-demo fixture (digests, sql migrations)", () => {
    expect(built(EXT, extOptions()).yaml).toMatchSnapshot();
  });

  it("has a web service, one service per worker and a migrator behind the migrate profile", () => {
    const s = services(built(IGS, igsOptions()).yaml);
    expect(Object.keys(s)).toEqual(["web", "worker", "migrate"]);
    expect(s.migrate).toMatchObject({ profiles: ["migrate"], entrypoint: ["drizzle-kit", "migrate"] });
    expect(s.worker!.image).toBe(`ghcr.io/alisafari-it/igs-pharma-worker:${SHA}`);
    // a migration runs once and is not restarted: no restart policy, so compose's default ("no") applies
    expect(s.migrate!.restart).toBeUndefined();
    expect(s.web!.restart).toBe("unless-stopped");
  });

  it("hardens every service like `pnpm dev:app` does, with the manifest's limits", () => {
    const s = services(built(IGS, igsOptions()).yaml);
    for (const [name, svc] of Object.entries(s)) {
      expect(svc, name).toMatchObject({
        read_only: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"],
        security_opt: ["no-new-privileges:true"],
        cap_drop: ["ALL"],
      });
      expect(svc.privileged, name).toBeUndefined();
      expect(svc.ports, name).toBeUndefined();
      expect(svc.volumes, name).toBeUndefined();
    }
    expect(s.web).toMatchObject({ mem_limit: "512m", cpus: 1 });
    expect(s.worker).toMatchObject({ mem_limit: "256m", cpus: 0.5 });
  });

  it("gives the migrator DSN to the migrator only", () => {
    const { yaml } = built(IGS, igsOptions());
    const s = services(yaml);
    expect(s.migrate!.environment).toEqual({
      DATABASE_URL: "${IGS_PHARMA_MIGRATOR_DATABASE_URL:?set IGS_PHARMA_MIGRATOR_DATABASE_URL}",
    });
    for (const name of ["web", "worker"]) {
      const text = JSON.stringify(s[name]);
      expect(text, name).not.toContain("MIGRATOR");
      expect(s[name]!.environment, name).toMatchObject({
        DATABASE_URL: "${IGS_PHARMA_DATABASE_URL:?set IGS_PHARMA_DATABASE_URL}",
      });
    }
    // and nowhere else in the file but the migrator service (and the header's list of what is needed)
    const outside = yaml
      .split("\n")
      .filter((l) => l.includes("MIGRATOR") && !l.startsWith("#"))
      .map((l) => l.trim());
    expect(outside).toEqual([
      "DATABASE_URL: ${IGS_PHARMA_MIGRATOR_DATABASE_URL:?set IGS_PHARMA_MIGRATOR_DATABASE_URL}",
    ]);
  });

  it("gives the web service and every worker the declared secrets, and the migrator none", () => {
    const s = services(built(IGS, igsOptions()).yaml);
    for (const name of ["web", "worker"]) {
      expect(Object.keys(s[name]!.environment as object), name).toEqual([
        "DATABASE_URL",
        "IGS_SESSION_SECRET",
        "IGS_MAIL_API_KEY",
      ]);
    }
    expect(Object.keys(s.migrate!.environment as object)).toEqual(["DATABASE_URL"]);
  });

  it("narrows a secret to the processes named in its scope", () => {
    const s = services(
      built(IGS, igsOptions({ scopes: { IGS_MAIL_API_KEY: ["worker"], IGS_SESSION_SECRET: ["web"] } })).yaml,
    );
    expect(Object.keys(s.web!.environment as object)).toEqual(["DATABASE_URL", "IGS_SESSION_SECRET"]);
    expect(Object.keys(s.worker!.environment as object)).toEqual(["DATABASE_URL", "IGS_MAIL_API_KEY"]);
  });

  it("puts only the web service on the edge network, with its port exposed and nothing published", () => {
    const doc = parse(built(IGS, igsOptions()).yaml) as {
      services: Record<string, { networks: Record<string, unknown>; expose?: string[] }>;
      networks: Record<string, unknown>;
    };
    expect(doc.services.web!.networks).toEqual({
      app_net: {},
      db_net: {},
      edge_net: { aliases: ["os-app-igs-pharma-staging"] },
    });
    expect(doc.services.web!.expose).toEqual(["3000"]);
    expect(doc.services.worker!.networks).toEqual({ app_net: {}, db_net: {}, egress_net: {} });
    expect(doc.services.worker!.expose).toBeUndefined();
    expect(doc.services.migrate!.networks).toEqual({ db_net: {} });
    expect(doc.networks).toEqual({
      app_net: { internal: true },
      edge_net: { external: true, name: "edge_net" },
      db_net: { external: true, name: "igs_pharma_staging_db" },
      egress_net: {},
    });
  });

  it("keeps a worker with no egress off the internet", () => {
    const doc = parse(built(EXT, extOptions()).yaml) as {
      services: Record<string, { networks: Record<string, unknown> }>;
      networks: Record<string, unknown>;
    };
    expect(doc.services.jobs!.networks).toEqual({ app_net: {}, db_net: {} });
    expect(doc.networks).not.toHaveProperty("egress_net");
  });

  it("names the staging and prod stacks apart and says what the gateway needs", () => {
    const staging = built(IGS, igsOptions({ env: "staging" }));
    const prod = built(IGS, igsOptions({ env: "prod" }));
    expect(staging.project).toBe("os-app-igs-pharma-staging");
    expect(prod.project).toBe("os-app-igs-pharma");
    expect(prod.upstream).toEqual({ variable: "OS_APP_IGS_PHARMA_UPSTREAM", value: "os-app-igs-pharma:3000" });
    expect(parse(prod.yaml).networks.db_net.name).toBe("igs_pharma_db");
  });

  it("lists the variables compose asks for, by name, and who gets each", () => {
    expect(built(IGS, igsOptions()).variables).toEqual([
      { name: "IGS_PHARMA_DATABASE_URL", for: ["web", "worker"] },
      { name: "IGS_SESSION_SECRET", for: ["web", "worker"] },
      { name: "IGS_MAIL_API_KEY", for: ["web", "worker"] },
      { name: "IGS_PHARMA_MIGRATOR_DATABASE_URL", for: ["migrate"] },
    ]);
  });

  it("has no database, network or migrator for an app that declares none", () => {
    const m = { ...IGS, database: { engine: "none" as const }, secrets: [] };
    const doc = parse(built(m, igsOptions()).yaml) as { services: Record<string, unknown>; networks: object };
    expect(Object.keys(doc.services)).toEqual(["web", "worker"]);
    expect(doc.networks).not.toHaveProperty("db_net");
    expect(JSON.stringify(doc)).not.toContain("DATABASE_URL");
  });
});

describe("images", () => {
  it.each([
    ["latest", "ghcr.io/alisafari-it/igs-pharma-web:latest"],
    ["a version tag", "ghcr.io/alisafari-it/igs-pharma-web:v1.2.3"],
    ["no tag", "ghcr.io/alisafari-it/igs-pharma-web"],
    ["a short sha", "ghcr.io/alisafari-it/igs-pharma-web:0123456"],
  ])("refuses %s in prod and in staging", (_what, image) => {
    for (const env of ["prod", "staging"] as const) {
      const result = buildCompose(IGS, { env, image });
      expect(result.ok, env).toBe(false);
      if (!result.ok) expect(result.lines.join("\n")).toMatch(/isn't pinned/);
    }
  });

  it("accepts a digest and a full commit sha tag", () => {
    expect(buildCompose(IGS, { env: "prod", image: WEB }).ok).toBe(true);
    const digest = `ghcr.io/alisafari-it/igs-pharma-web@${DIGEST}`;
    const result = buildCompose(IGS, {
      env: "prod",
      image: digest,
      workerImages: { worker: `ghcr.io/alisafari-it/igs-pharma-worker@${DIGEST}` },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a floating worker image, and a digest web image whose worker can't be derived", () => {
    const digest = `ghcr.io/alisafari-it/igs-pharma-web@${DIGEST}`;
    const floating = buildCompose(IGS, { env: "prod", image: digest, workerImages: { worker: "x/worker:latest" } });
    expect(floating.ok).toBe(false);
    const underived = buildCompose(IGS, { env: "prod", image: digest });
    expect(underived.ok).toBe(false);
    if (!underived.ok) expect(underived.lines.join("\n")).toContain("--worker-image worker=");
  });

  it("refuses a worker image for a worker that doesn't exist", () => {
    const result = buildCompose(IGS, igsOptions({ workerImages: { nope: `x/y@${DIGEST}` } }));
    expect(result.ok).toBe(false);
  });
});

describe("refusals", () => {
  it("wants the migrator's command when the migrations are `sql`", () => {
    const result = buildCompose(EXT, extOptions({ migrateCommand: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.lines.join("\n")).toContain("--migrate-command");
  });

  it("refuses a scope for a secret or a process the app doesn't have", () => {
    const result = buildCompose(IGS, igsOptions({ scopes: { NOPE: ["web"], IGS_MAIL_API_KEY: ["cron"] } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.lines.join("\n");
      expect(text).toContain("doesn't declare a secret called NOPE");
      expect(text).toContain('no process "cron"');
    }
  });

  it.each(["DATABASE_URL", "IGS_PHARMA_DATABASE_URL", "IGS_PHARMA_MIGRATOR_DATABASE_URL"])(
    "refuses a declared secret named %s, which would hand a database credential to the wrong process",
    (name) => {
      const result = buildCompose({ ...IGS, secrets: [name, "IGS_MAIL_API_KEY"] }, igsOptions());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.lines.join("\n")).toContain(`the secret ${name} would clash`);
    },
  );

  it("lets an app with no database use those names for its secrets", () => {
    const m = { ...IGS, database: { engine: "none" as const }, secrets: ["IGS_PHARMA_DATABASE_URL"] };
    expect(buildCompose(m, igsOptions()).ok).toBe(true);
  });

  it("reports every problem at once", () => {
    const result = buildCompose(EXT, { env: "prod", image: "x/ext-demo:latest" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.lines.length).toBeGreaterThan(3);
  });
});

describe("secret values never reach the file or the output", () => {
  const VALUE = "SUPER-secret-VALUE-0123";
  beforeEach(() => {
    process.env.IGS_SESSION_SECRET = VALUE;
    process.env.IGS_PHARMA_DATABASE_URL = `postgres://u:${VALUE}@db/x`;
    process.env.IGS_PHARMA_MIGRATOR_DATABASE_URL = `postgres://m:${VALUE}@db/x`;
  });
  afterEach(() => {
    delete process.env.IGS_SESSION_SECRET;
    delete process.env.IGS_PHARMA_DATABASE_URL;
    delete process.env.IGS_PHARMA_MIGRATOR_DATABASE_URL;
  });

  it("holds only ${NAME} references, whatever the environment contains", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "compose-secret-"));
    try {
      const out = path.join(dir, "compose.yml");
      const result = await composeCommand(
        [
          "--manifest",
          path.join(fixtures, "igs-shaped/platform.app.json"),
          "--image",
          WEB,
          "--env",
          "staging",
          "--out",
          out,
        ],
        dir,
        dir,
        fakeDocker({}),
      );
      expect(result?.ok).toBe(true);
      const everything = `${readFileSync(out, "utf8")}\n${result!.lines.join("\n")}`;
      expect(everything).not.toContain(VALUE);
      expect(everything).not.toMatch(/postgres:\/\//);
      for (const line of readFileSync(out, "utf8").split("\n")) {
        if (/(SECRET|API_KEY|DATABASE_URL):/.test(line)) expect(line).toMatch(/: \$\{[A-Z_]+:\?set [A-Z_]+\}$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("platform app compose", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "compose-cmd-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manifestArgs = ["--manifest", path.join(fixtures, "igs-shaped/platform.app.json"), "--image", WEB];

  it("writes the file and prints the gateway upstream and the variable names", async () => {
    const out = path.join(dir, "out", "compose.staging.yml");
    const result = await composeCommand(
      [...manifestArgs, "--env", "staging", "--out", "out/compose.staging.yml"],
      dir,
      dir,
    );
    expect(result?.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    const text = result!.lines.join("\n");
    expect(text).toContain("OS_APP_IGS_PHARMA_UPSTREAM=os-app-igs-pharma-staging:3000");
    expect(text).toContain("IGS_PHARMA_MIGRATOR_DATABASE_URL  (migrate)");
  });

  it("writes nothing when an image is floating", async () => {
    const result = await composeCommand(
      [
        "--manifest",
        path.join(fixtures, "igs-shaped/platform.app.json"),
        "--image",
        "x/igs-pharma-web:latest",
        "--env",
        "prod",
        "--out",
        "compose.yml",
      ],
      dir,
      dir,
    );
    expect(result).toMatchObject({ ok: false });
    expect(result!.lines.at(-1)).toBe("Nothing was written.");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reads an installed app's manifest and image from external-apps/<id>/", async () => {
    const appDir = path.join(dir, "external-apps", "igs-pharma");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, "platform.app.json"),
      readFileSync(path.join(fixtures, "igs-shaped/platform.app.json")),
    );
    writeFileSync(path.join(appDir, "source.json"), JSON.stringify({ image: WEB }));
    const result = await composeCommand(["igs-pharma", "--env", "prod", "--out", "c.yml"], dir, dir);
    expect(result?.ok, result?.lines.join("\n")).toBe(true);
    expect(parse(readFileSync(path.join(dir, "c.yml"), "utf8")).services.web.image).toBe(WEB);
  });

  it("reads the manifest from an image's label when the argument is an image reference", async () => {
    const label = {
      "org.asafarim.app.manifest": readFileSync(path.join(fixtures, "igs-shaped/platform.app.json"), "utf8"),
    };
    const result = await composeCommand(
      [WEB, "--env", "staging", "--out", "c.yml"],
      dir,
      dir,
      fakeDocker({ local: { [WEB]: label } }),
    );
    expect(result?.ok, result?.lines.join("\n")).toBe(true);
  });

  it("stops with the reason when the image can't be read", async () => {
    const result = await composeCommand([WEB, "--env", "staging", "--out", "c.yml"], dir, dir, fakeDocker({}));
    expect(result).toMatchObject({ ok: false });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("passes --worker-image, --scope and --migrate-command through", async () => {
    const digest = `ghcr.io/alisafari-it/igs-pharma-web@${DIGEST}`;
    const result = await composeCommand(
      [
        "--manifest",
        path.join(fixtures, "igs-shaped/platform.app.json"),
        "--image",
        digest,
        "--env",
        "prod",
        "--out",
        "c.yml",
        "--worker-image",
        `worker=ghcr.io/alisafari-it/igs-pharma-worker@${DIGEST}`,
        "--scope",
        "IGS_MAIL_API_KEY=worker",
        "--migrate-command",
        '["node","migrate.mjs"]',
      ],
      dir,
      dir,
    );
    expect(result?.ok, result?.lines.join("\n")).toBe(true);
    const s = services(readFileSync(path.join(dir, "c.yml"), "utf8"));
    expect(s.migrate!.entrypoint).toEqual(["node", "migrate.mjs"]);
    expect(Object.keys(s.web!.environment as object)).not.toContain("IGS_MAIL_API_KEY");
    expect(s.worker!.image).toBe(`ghcr.io/alisafari-it/igs-pharma-worker@${DIGEST}`);
  });

  it("prints its help", async () => {
    const result = await composeCommand(["--help"], dir, dir);
    expect(result).toEqual({ ok: true, lines: COMPOSE_HELP });
    expect(COMPOSE_HELP.join("\n")).toContain("--env prod|staging");
  });

  it.each([
    [[], "--env must be prod or staging"],
    [["--env", "prod", "--out", "c"], "give an installed app"],
    [["x"], "--env must be prod or staging"],
    [["x", "--env", "dev", "--out", "c"], "--env must be prod or staging"],
    [["x", "--env", "prod"], "--out <file> is required"],
    [["x", "--env", "prod", "--out", "c", "--bogus"], "unknown option --bogus"],
    [["x", "y", "--env", "prod", "--out", "c"], "unexpected argument y"],
    [["--manifest", "m.json", "--env", "prod", "--out", "c"], "go together"],
    [["x", "--manifest", "m.json", "--image", "i", "--env", "prod", "--out", "c"], "go together"],
    [["x", "--env", "prod", "--out", "c", "--migrate-command", "node"], "Unexpected token"],
    [["x", "--env", "prod", "--out", "c", "--migrate-command", "[]"], "JSON array of strings"],
    [["x", "--env", "prod", "--out", "c", "--scope", "A"], "--scope takes"],
    [["x", "--env", "prod", "--out", "c", "--worker-image", "w"], "--worker-image takes"],
    [["x", "--env"], "--env needs a value"],
  ])("rejects %j", (args, message) => {
    const parsed = parseComposeArgs(args);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain(message);
  });
});

/** The generated files, for real: `docker compose config` accepts them (CI must have docker, so it can't skip there). */
const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const hasCompose = compose.status === 0;
describe("docker compose config", () => {
  it.skipIf(!hasCompose && !process.env.CI)(
    "accepts the generated files",
    () => {
      expect(hasCompose, "docker compose is needed in CI").toBe(true);
      const dir = mkdtempSync(path.join(tmpdir(), "compose-config-"));
      try {
        const cases: [string, AppManifest, ComposeOptions][] = [
          ["igs-staging", IGS, igsOptions({ env: "staging" })],
          ["igs-prod", IGS, igsOptions({ env: "prod" })],
          ["ext-demo-prod", EXT, extOptions({ env: "prod" })],
          ["ext-demo-staging", EXT, extOptions({ env: "staging" })],
        ];
        for (const [name, manifest, options] of cases) {
          const file = built(manifest, options);
          const out = path.join(dir, `${name}.yml`);
          writeFileSync(out, file.yaml);
          // The variables compose insists on get stand-ins of the right shape; none is a real value.
          const env = {
            ...process.env,
            ...Object.fromEntries(file.variables.map((v) => [v.name, `stand-in-${v.name}`])),
          };
          const r = spawnSync("docker", ["compose", "-f", out, "config", "--quiet"], { encoding: "utf8", env });
          expect(r.stderr, name).toBe("");
          expect(r.status, name).toBe(0);
          // and it refuses to start without them
          const bare = spawnSync("docker", ["compose", "-f", out, "config", "--quiet"], {
            encoding: "utf8",
            env: Object.fromEntries(
              Object.entries(process.env).filter(([k]) => !file.variables.some((v) => v.name === k)),
            ),
          });
          expect(bare.status, `${name} without its variables`).not.toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
