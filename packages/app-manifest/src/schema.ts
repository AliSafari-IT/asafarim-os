/**
 * The app manifest: how an app describes itself to the platform.
 *
 * Structure is checked by the Zod schema (also exported as JSON Schema).
 * Rules that relate fields to each other — the namespace rule, role grants,
 * route permissions, duplicates, config defaults — are checked in
 * `superRefine` below; JSON Schema can't express them, so `validateManifest`
 * is the authority and the JSON Schema is for editors and external tooling.
 */
import { validRange } from "semver";
import { z } from "zod";

/** Ids the platform keeps for itself (hosts, namespaces, core services). */
export const RESERVED_APP_IDS = [
  "admin",
  "api",
  "app",
  "apps",
  "asafarim",
  "assets",
  "auth",
  "core",
  "gateway",
  "id",
  "identity",
  "internal",
  "mail",
  "platform",
  "static",
  "system",
  "www",
] as const;

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** semver 2.0, no leading "v". */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** A dotted, lower-case key: `<segment>.<segment>[...]`. */
const DOTTED_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
/** `<app>.<entity>.<verb>.v<N>`. */
const EVENT_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9]\d*$/;
/** Environment variable names, upper snake case. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Docker-style memory size: `256m`, `1.5g`. */
const MEMORY = /^(?:[1-9]\d*|\d+\.\d+)[mg]$/;
/** OCI image name, optionally with a tag. */
const IMAGE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[\w][\w.-]{0,127})?$/;

const urlPath = z.string().regex(/^\/[^\s?#]*$/, "must be a path starting with /");
/** Route patterns may use `*` (one segment) and `**` (any depth). */
const routePath = z.string().regex(/^\/[A-Za-z0-9._~\-/*[\]:]*$/, "must be a path starting with / (globs: * and **)");

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Required on every service: the host is shared, so nothing runs unbounded. */
const resources = z.strictObject(
  {
    memory: z.string().regex(MEMORY, 'must be a memory size such as "256m" or "1g"'),
    cpus: z.number().positive().max(16),
  },
  { error: (iss) => (iss.input === undefined ? 'is required: { memory: "256m", cpus: 0.5 }' : undefined) },
);

const worker = z.strictObject({
  name: z.string().regex(KEBAB, "must be kebab-case"),
  image: z.string().regex(IMAGE, "must be an image name, optionally with :tag"),
  network: z.enum(["internal", "egress-only"]),
  /** Every service on the shared host declares its limits, workers included. */
  resources,
});

const configEntry = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/, "must be a dotted camelCase key"),
  type: z.enum(["string", "int", "number", "boolean"]),
  default: z.union([z.string(), z.number(), z.boolean()]),
  description: z.string().min(1).optional(),
});

/** Tell a likely secret value apart from a mistyped name, for a clearer error. */
function looksLikeValue(s: string): boolean {
  // URLs, assignments and anything with spaces, or a long mixed-case/digit token.
  if (/[=:/\s]/.test(s)) return true;
  return s.length >= 16 && /[a-z]/.test(s) && /\d/.test(s);
}

const secretName = z.string().superRefine((s, ctx) => {
  if (ENV_NAME.test(s)) return;
  ctx.addIssue({
    code: "custom",
    message: looksLikeValue(s)
      ? "looks like a secret value; list the environment variable NAME only (e.g. GITHUB_TOKEN)"
      : "must be an environment variable name in UPPER_SNAKE_CASE",
  });
});

const baseManifest = z.strictObject({
  /** Stable, kebab-case, never reused. Also the namespace of everything the app declares. */
  id: z
    .string()
    .min(2)
    .max(32)
    .regex(KEBAB, "must be kebab-case (a-z, 0-9, single dashes)")
    .refine((id) => !(RESERVED_APP_IDS as readonly string[]).includes(id), "is reserved by the platform"),
  name: z.string().min(1).max(64),
  version: z.string().regex(SEMVER, 'must be a semver version such as "1.4.0"'),
  /** Compatible core versions, e.g. ">=1.0 <2". */
  platform: z.string().refine((r) => validRange(r) !== null, "must be a valid semver range"),
  owner: z.string().min(1).max(120),
  domains: z
    .strictObject({
      primary: z.string().regex(HOSTNAME, "must be a lower-case hostname").optional(),
      aliases: z.array(z.string().regex(HOSTNAME, "must be a lower-case hostname")).optional(),
    })
    .optional(),
  runtime: z.strictObject({
    image: z.string().regex(IMAGE, "must be an image name, optionally with :tag"),
    port: z.number().int().min(1).max(65535),
    health: z.strictObject({ live: urlPath, ready: urlPath }),
    resources,
    workers: z.array(worker).optional(),
  }),
  database: z.discriminatedUnion("engine", [
    z.strictObject({
      engine: z.literal("postgres"),
      migrations: z.enum(["drizzle", "prisma", "sql"]),
      dedicated: z.boolean().optional(),
    }),
    z.strictObject({ engine: z.literal("none") }),
  ]),
  auth: z.strictObject({
    client: z.enum(["oidc", "none"]),
    publicPaths: z.array(urlPath),
  }),
  permissions: z.array(
    z.strictObject({
      key: z.string().regex(DOTTED_KEY, "must be <app>.<resource>.<action> in lower case"),
      description: z.string().min(1),
    }),
  ),
  roles: z.array(
    z.strictObject({
      key: z.string().regex(DOTTED_KEY, "must be <app>.<role> in lower case"),
      grants: z.array(z.string().min(1)).min(1),
      description: z.string().min(1).optional(),
    }),
  ),
  routes: z
    .array(
      z.strictObject({
        path: routePath,
        methods: z.array(z.enum(HTTP_METHODS)).min(1).optional(),
        permission: z.string().optional(),
        /** false: the gateway answers 404 on every host (e.g. /internal/**). */
        expose: z.boolean().optional(),
      }),
    )
    .optional(),
  events: z
    .strictObject({
      publishes: z
        .array(
          z.strictObject({
            type: z.string().regex(EVENT_TYPE, "must be <app>.<entity>.<verb>.v<N>"),
            schema: z.string().regex(/^\.\/[\w./-]+\.json$/, "must be a relative path to a .json JSON Schema"),
          }),
        )
        .optional(),
      subscribes: z
        .array(
          z.strictObject({
            type: z.string().regex(EVENT_TYPE, "must be <app>.<entity>.<verb>.v<N>"),
            handler: urlPath,
          }),
        )
        .optional(),
    })
    .optional(),
  config: z.array(configEntry).optional(),
  /** Names of the secrets the app needs. Values never appear in a manifest. */
  secrets: z.array(secretName).optional(),
  ui: z.strictObject({
    glyph: z.string().regex(/^[A-Z0-9]{1,3}$/, "must be 1–3 upper-case letters or digits"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour such as "#7c3aed"'),
    nav: z.array(z.strictObject({ label: z.string().min(1), href: urlPath })),
    status: z.enum(["active", "coming-soon"]),
  }),
});

type Ctx = z.RefinementCtx;
const issue = (ctx: Ctx, path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

/*
 * The cross-field rules run even when the structure has errors (`when`
 * below), so one validation reports every problem. The value is therefore
 * NOT guaranteed to match the schema here: read it through these lenient
 * helpers, which skip anything malformed (the structural issue already
 * reports it).
 */
type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** `[index, record]` for each object entry of an array field. */
const entries = (v: unknown) => list(v).flatMap((e, i) => (obj(e) ? [[i, obj(e)!] as const] : []));

function dupes(ctx: Ctx, values: (string | undefined)[], path: (i: number) => (string | number)[], what: string) {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (v === undefined) return;
    if (seen.has(v)) issue(ctx, path(i), `duplicate ${what} "${v}"`);
    seen.add(v);
  });
}

function crossFieldRules(value: unknown, ctx: Ctx): void {
  const m = obj(value);
  const id = str(m?.id);
  if (!m || !id) return; // nothing to anchor the namespace rules on
  const ns = `${id}.`;
  const outside = (key: string) => !key.startsWith(ns);

  const permissions = entries(m.permissions);
  permissions.forEach(([i, p]) => {
    const key = str(p.key);
    if (key && outside(key)) issue(ctx, ["permissions", i, "key"], `must be in the app's own namespace "${ns}*"`);
  });
  dupes(
    ctx,
    list(m.permissions).map((p) => str(obj(p)?.key)),
    (i) => ["permissions", i, "key"],
    "permission",
  );
  const declared = new Set(permissions.map(([, p]) => str(p.key)).filter((k): k is string => k !== undefined));

  entries(m.roles).forEach(([i, r]) => {
    const key = str(r.key);
    if (key && outside(key)) issue(ctx, ["roles", i, "key"], `must be in the app's own namespace "${ns}*"`);
    list(r.grants).forEach((g, j) => {
      if (typeof g !== "string" || g === `${id}.*` || declared.has(g)) return;
      issue(
        ctx,
        ["roles", i, "grants", j],
        outside(g)
          ? `grants "${g}", outside the app's own namespace; a role may only grant this app's permissions`
          : `grants "${g}", which isn't declared in permissions (or use "${id}.*")`,
      );
    });
  });
  dupes(
    ctx,
    list(m.roles).map((r) => str(obj(r)?.key)),
    (i) => ["roles", i, "key"],
    "role",
  );

  entries(m.routes).forEach(([i, r]) => {
    const permission = str(r.permission);
    if (permission === undefined) return;
    if (r.expose === false) {
      issue(
        ctx,
        ["routes", i, "permission"],
        "a route with expose: false is never served, so it can't need a permission",
      );
    } else if (!declared.has(permission)) {
      issue(ctx, ["routes", i, "permission"], `"${permission}" isn't declared in permissions`);
    }
  });

  const publishes = obj(m.events)?.publishes;
  entries(publishes).forEach(([i, e]) => {
    const type = str(e.type);
    if (type && outside(type))
      issue(ctx, ["events", "publishes", i, "type"], `must be in the app's own namespace "${ns}*"`);
  });
  dupes(
    ctx,
    list(publishes).map((e) => str(obj(e)?.type)),
    (i) => ["events", "publishes", i, "type"],
    "event type",
  );

  entries(m.config).forEach(([i, c]) => {
    const d = c.default;
    const ok =
      c.type === "string"
        ? typeof d === "string"
        : c.type === "boolean"
          ? typeof d === "boolean"
          : c.type === "int"
            ? typeof d === "number" && Number.isInteger(d)
            : c.type === "number"
              ? typeof d === "number"
              : true; // an unknown type is reported structurally
    if (!ok) issue(ctx, ["config", i, "default"], `must be a ${String(c.type)}`);
  });
  dupes(
    ctx,
    list(m.config).map((c) => str(obj(c)?.key)),
    (i) => ["config", i, "key"],
    "config key",
  );
  dupes(ctx, list(m.secrets).map(str), (i) => ["secrets", i], "secret");

  const domains = obj(m.domains);
  const primary = str(domains?.primary);
  if (primary && list(domains?.aliases).includes(primary)) {
    issue(ctx, ["domains", "aliases"], "must not repeat the primary domain");
  }
  const workers = obj(m.runtime)?.workers;
  dupes(
    ctx,
    list(workers).map((w) => str(obj(w)?.name)),
    (i) => ["runtime", "workers", i, "name"],
    "worker",
  );
}

/** The structure plus the cross-field rules. */
export const AppManifestSchema = baseManifest.superRefine(crossFieldRules, {
  // Run even when the structure already failed, so every problem is reported at once.
  when: () => true,
});

export type AppManifest = z.infer<typeof AppManifestSchema>;
/** What an app author writes (before defaults are applied). */
export type AppManifestInput = z.input<typeof AppManifestSchema>;

/** The structural part as JSON Schema (cross-field rules aren't representable). */
export function appManifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(baseManifest, { target: "draft-2020-12", io: "input" }) as {
    properties: Record<string, Record<string, unknown>>;
  };
  // Two refinements JSON Schema *can* express; Zod can't export refine() bodies.
  schema.properties.id = { ...schema.properties.id, not: { enum: [...RESERVED_APP_IDS] } };
  schema.properties.secrets = { type: "array", items: { type: "string", pattern: ENV_NAME.source } };
  return {
    ...schema,
    $id: "https://asafarim.site/schemas/app-manifest.schema.json",
    title: "ASafarIM OS app manifest",
    description:
      "Structure of platform.app.json. Cross-field rules (namespacing, role grants, route permissions, duplicates, config default types) are enforced by @asafarim/app-manifest's validateManifest.",
  };
}
