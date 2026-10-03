/**
 * Compare app manifests with a platform's hand-written wiring and report every
 * disagreement, without changing anything. Pure: give it the loaded data.
 *
 * How a manifest is matched to the hand-written files:
 *   registry   entry `key` = manifest `id`
 *   compose    service named `runtime.image`; workers: service named the worker's image;
 *              a dedicated database is the service `<id>-postgres`
 *   bake/plan  target / image named `runtime.image` and each worker image
 *   gateway    a site for `domains.primary` (default `<id>.asafarim.site`) and each alias
 * Migration and seed jobs (`<image>-migrate`, `<image>-migrator`, `<image>-seed`) belong
 * to their app. Platform services (database server, cache, gateway) belong to no app.
 */
import { defaultHost, type AppManifest } from "@asafarim/app-manifest";
import { bytes, type ComposeService, type PlatformWiring } from "./load.ts";

export const AREAS = ["registry", "compose", "bake", "plan", "gateway"] as const;
export type Area = (typeof AREAS)[number];

export interface AppDrift {
  app: string;
  file: string;
  /** Empty array = the area agrees. */
  areas: Record<Area, string[]>;
  /** The manifest itself is invalid (nothing else is compared). */
  invalid?: string[];
}

export interface DriftReport {
  apps: AppDrift[];
  /** Present in the hand-written files, claimed by no manifest. */
  unclaimed: Record<Area, string[]>;
  /** Gateway sites declared as another stack's (--other-stack-sites): listed, not drift. */
  otherStack: string[];
  platformServices: string[];
  ok: boolean;
}

/** Infrastructure that belongs to the platform, not to an app. */
export const DEFAULT_PLATFORM_SERVICES = ["postgres", "redis", "caddy", "platform-migrate"];

const JOB_SUFFIXES = ["-migrate", "-migrator", "-seed"];

function jobOf(name: string, image: string): boolean {
  return JOB_SUFFIXES.some((s) => name === `${image}${s}` || (name.startsWith(`${image}-`) && name.endsWith(s)));
}

function limits(service: ComposeService, want: { memory: string; cpus: number }, label: string): string[] {
  const out: string[] = [];
  if (service.memory === undefined) out.push(`${label}: no mem_limit in compose (manifest: ${want.memory})`);
  else if (bytes(service.memory) !== bytes(want.memory)) {
    out.push(`${label}: mem_limit ${service.memory} ≠ manifest ${want.memory}`);
  }
  if (service.cpus === undefined) out.push(`${label}: no cpus in compose (manifest: ${want.cpus})`);
  else if (service.cpus !== want.cpus) out.push(`${label}: cpus ${service.cpus} ≠ manifest ${want.cpus}`);
  return out;
}

function checkApp(m: AppManifest, w: PlatformWiring, coreNetworks: Set<string>) {
  const areas: Record<Area, string[]> = { registry: [], compose: [], bake: [], plan: [], gateway: [] };

  const reg = w.registry.find((r) => r.key === m.id);
  if (!reg) areas.registry.push(`no registry entry with key "${m.id}"`);
  else {
    if (reg.name !== m.name) areas.registry.push(`name "${reg.name}" ≠ manifest "${m.name}"`);
    if (reg.glyph !== m.ui.glyph) areas.registry.push(`glyph "${reg.glyph}" ≠ manifest "${m.ui.glyph}"`);
    if (reg.status !== m.ui.status) areas.registry.push(`status "${reg.status}" ≠ manifest "${m.ui.status}"`);
  }

  const service = (name: string) => w.compose.find((s) => s.name === name);
  const app = service(m.runtime.image);
  if (!app) areas.compose.push(`no service "${m.runtime.image}"`);
  else areas.compose.push(...limits(app, m.runtime.resources, m.runtime.image));
  for (const worker of m.runtime.workers ?? []) {
    const s = service(worker.image);
    if (!s) {
      areas.compose.push(`no service "${worker.image}" for worker "${worker.name}"`);
      continue;
    }
    areas.compose.push(...limits(s, worker.resources, worker.image));
    const onCore = s.networks.filter((n) => coreNetworks.has(n));
    if (worker.network === "egress-only" && onCore.length > 0) {
      areas.compose.push(`${worker.image}: egress-only worker is on the platform network ${onCore.join(", ")}`);
    }
  }
  const dbService = service(`${m.id}-postgres`);
  const dedicated = m.database.engine === "postgres" && m.database.dedicated === true;
  if (dedicated && !dbService) areas.compose.push(`database.dedicated, but no service "${m.id}-postgres"`);
  if (!dedicated && dbService)
    areas.compose.push(`service "${m.id}-postgres" exists, but the manifest doesn't declare a dedicated database`);

  // Images this repo builds: the app and every worker whose compose service is built here.
  const built = [m.runtime.image, ...(m.runtime.workers ?? []).map((wk) => wk.image)].filter(
    (img) => service(img)?.built === true || w.bakeTargets.includes(img),
  );
  for (const img of built) {
    if (!w.bakeTargets.includes(img)) areas.bake.push(`no bake target "${img}"`);
    if (!w.planImages.includes(img)) areas.plan.push(`no build-plan image "${img}"`);
  }

  const hosts = [m.domains?.primary ?? defaultHost(m.id), ...(m.domains?.aliases ?? [])];
  for (const h of hosts) if (!w.caddyHosts.includes(h)) areas.gateway.push(`no site for ${h}`);

  return areas;
}

export function computeDrift(
  w: PlatformWiring,
  opts: { platformServices?: string[]; otherStackSites?: string[] } = {},
): DriftReport {
  const otherStackSites = new Set(opts.otherStackSites ?? []);
  const platformServices = opts.platformServices ?? DEFAULT_PLATFORM_SERVICES;
  const coreNetworks = new Set(
    w.compose.filter((s) => platformServices.includes(s.name) && s.name !== "caddy").flatMap((s) => s.networks),
  );
  const claimed: Record<Area, Set<string>> = {
    registry: new Set(),
    compose: new Set(platformServices),
    bake: new Set(platformServices),
    plan: new Set(platformServices),
    gateway: new Set(),
  };

  const apps: AppDrift[] = w.manifests.map((lm) => {
    if (!lm.manifest) {
      return {
        app: lm.folder,
        file: lm.file,
        areas: { registry: [], compose: [], bake: [], plan: [], gateway: [] },
        invalid: (lm.problems ?? []).map((p) => `${p.path || "(manifest)"}: ${p.message}`),
      };
    }
    const m = lm.manifest;
    claimed.registry.add(m.id);
    const images = [m.runtime.image, ...(m.runtime.workers ?? []).map((wk) => wk.image)];
    for (const s of w.compose) {
      if (images.includes(s.name) || s.name === `${m.id}-postgres` || jobOf(s.name, m.runtime.image))
        claimed.compose.add(s.name);
    }
    for (const t of [...w.bakeTargets, ...w.planImages]) {
      if (images.includes(t) || jobOf(t, m.runtime.image)) {
        claimed.bake.add(t);
        claimed.plan.add(t);
      }
    }
    for (const h of [m.domains?.primary ?? defaultHost(m.id), ...(m.domains?.aliases ?? [])]) claimed.gateway.add(h);
    return { app: m.id, file: lm.file, areas: checkApp(m, w, coreNetworks) };
  });

  const unclaimed: Record<Area, string[]> = {
    registry: w.registry.map((r) => r.key).filter((k) => !claimed.registry.has(k)),
    compose: w.compose.map((s) => s.name).filter((n) => !claimed.compose.has(n)),
    bake: w.bakeTargets.filter((t) => !claimed.bake.has(t)),
    plan: w.planImages.filter((i) => !claimed.plan.has(i)),
    gateway: w.caddyHosts.filter((h) => !claimed.gateway.has(h) && !otherStackSites.has(h)),
  };
  const otherStack = w.caddyHosts.filter((h) => !claimed.gateway.has(h) && otherStackSites.has(h));

  const ok =
    apps.every((a) => !a.invalid && AREAS.every((area) => a.areas[area].length === 0)) &&
    AREAS.every((area) => unclaimed[area].length === 0);
  return {
    apps,
    unclaimed,
    otherStack,
    platformServices: platformServices.filter((s) => w.compose.some((c) => c.name === s)),
    ok,
  };
}

/** A per-app ✔/✖ table, the reasons, then what no manifest claims. */
export function formatDrift(report: DriftReport): string[] {
  const width = Math.max(4, ...report.apps.map((a) => a.app.length));
  const mark = (a: AppDrift, area: Area) => (a.invalid ? "–" : a.areas[area].length === 0 ? "✔" : "✖");
  const lines = [
    `${"App".padEnd(width)}  ${AREAS.map((a) => a.padEnd(8)).join(" ")}`,
    ...report.apps.map((a) => `${a.app.padEnd(width)}  ${AREAS.map((area) => mark(a, area).padEnd(8)).join(" ")}`),
  ];
  for (const a of report.apps) {
    const reasons = a.invalid
      ? a.invalid.map((r) => `  ✖ invalid manifest — ${r}`)
      : AREAS.flatMap((area) => a.areas[area].map((r) => `  ✖ ${area}: ${r}`));
    if (reasons.length > 0) lines.push("", `${a.app} (${a.file})`, ...reasons);
  }
  const unclaimed = AREAS.filter((area) => report.unclaimed[area].length > 0);
  if (unclaimed.length > 0) {
    lines.push("", "Present by hand, claimed by no manifest:");
    for (const area of unclaimed) lines.push(`  ✖ ${area}: ${report.unclaimed[area].join(", ")}`);
  }
  if (report.otherStack.length > 0)
    lines.push("", `Other stacks on the same edge (not drift): ${report.otherStack.join(", ")}`);
  if (report.platformServices.length > 0)
    lines.push("", `Platform services (not apps): ${report.platformServices.join(", ")}`);
  lines.push("", report.ok ? "No drift." : "Drift found.");
  return lines;
}
