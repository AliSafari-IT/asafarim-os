/**
 * The Users page's access summary: per app, what is KNOWN about one person and why. Two owners, kept apart:
 * identity says whether the account may sign in to the app (its state and admission), core-api says which of the
 * app's roles it holds and where each came from (a direct grant, or a role mapping). A stored grant is never shown
 * as proof that someone can sign in: when identity can't be asked, admission is "unknown", not "yes".
 *
 * Pure, so every rule is unit-tested (test/access.test.ts).
 */
import type { AdminApp, RoleMapping, SubjectGrant } from "./core-api";
import { derivedFrom } from "./core-api";
import type { DirectoryPerson } from "./identity-api";

export type Admission =
  /** A global connection: every app. */
  | { kind: "global" }
  /** A per-app public admission to this app. */
  | { kind: "admitted" }
  /** Neither: the account can't sign in to this app. */
  | { kind: "not-admitted" }
  /** Suspended: no app, whatever else is stored. */
  | { kind: "suspended" }
  /** Identity couldn't be asked (or has no such account): nothing is claimed. */
  | { kind: "unknown"; reason: "unavailable" | "not-found" | "not-allowed" };

export type RoleReason =
  | { kind: "direct"; grantedBy: string; grantedAt: string }
  /** Made by a role mapping: the person holds `source` directly. `source` is null if the mapping is gone. */
  | { kind: "mapping"; mappingId: number; source: string | null; grantedAt: string };

export interface AppAccess {
  appId: string;
  appName: string;
  appState: AdminApp["state"];
  admission: Admission;
  roles: { role: string; reason: RoleReason }[];
  /** Holds roles here but can't sign in to the app (or that can't be known): worth a look. */
  attention: "roles-without-admission" | null;
}

export type IdentityFacts =
  | { ok: true; person: Pick<DirectoryPerson, "state" | "scope" | "admittedClients"> }
  | { ok: false; reason: "unavailable" | "not-found" | "not-allowed" };

export function admissionFor(facts: IdentityFacts, appId: string): Admission {
  if (!facts.ok) return { kind: "unknown", reason: facts.reason };
  const p = facts.person;
  if (p.state === "suspended") return { kind: "suspended" };
  if (p.scope === "global") return { kind: "global" };
  return p.admittedClients.includes(appId) ? { kind: "admitted" } : { kind: "not-admitted" };
}

export function reasonFor(grant: SubjectGrant, mappings: readonly RoleMapping[]): RoleReason {
  const via = derivedFrom(grant.granted_by);
  if (via === null) return { kind: "direct", grantedBy: grant.granted_by, grantedAt: grant.granted_at };
  return {
    kind: "mapping",
    mappingId: via,
    source: mappings.find((m) => m.id === via)?.source ?? null,
    grantedAt: grant.granted_at,
  };
}

/**
 * One row per app the person has anything in (an admission or a role), first; then the other apps, so an admin
 * sees where they have no access too. Removed apps are left out (nothing to grant there).
 */
export function accessByApp(
  apps: readonly Pick<AdminApp, "id" | "name" | "state">[],
  facts: IdentityFacts,
  grants: readonly SubjectGrant[],
  mappings: readonly RoleMapping[],
): AppAccess[] {
  const rows = apps
    .filter((a) => a.state !== "removed")
    .map((a): AppAccess => {
      const admission = admissionFor(facts, a.id);
      const roles = grants
        .filter((g) => g.appId === a.id)
        .map((g) => ({ role: g.role, reason: reasonFor(g, mappings) }))
        .sort((x, y) => x.role.localeCompare(y.role));
      const canSignIn = admission.kind === "global" || admission.kind === "admitted";
      return {
        appId: a.id,
        appName: a.name,
        appState: a.state,
        admission,
        roles,
        attention: roles.length > 0 && !canSignIn ? "roles-without-admission" : null,
      };
    });
  const hasSomething = (r: AppAccess) =>
    r.roles.length > 0 || r.admission.kind === "global" || r.admission.kind === "admitted";
  return [...rows.filter(hasSomething), ...rows.filter((r) => !hasSomething(r))];
}

/** What to call a person in a list: their label, else a shortened account id (the full one is shown beside it). */
export function personLabel(p: { label: string | null; id: string }): string {
  return p.label ?? `Account ${p.id.slice(0, 8)}…`;
}

/** The admission in words, for the page and for screen readers (never colour alone). */
export function admissionText(a: Admission): string {
  switch (a.kind) {
    case "global":
      return "Every app (approved connection)";
    case "admitted":
      return "Admitted to this app";
    case "not-admitted":
      return "Not admitted";
    case "suspended":
      return "Suspended: no app";
    case "unknown":
      return a.reason === "not-found"
        ? "Unknown: identity has no such account"
        : a.reason === "not-allowed"
          ? "Unknown: you can't read identity's directory"
          : "Unknown: identity isn't available";
  }
}

export const STATE_TEXT = { active: "Active", suspended: "Suspended" } as const;
export const SCOPE_TEXT = { global: "Every app", apps: "Some apps", none: "No app yet" } as const;

/** Whether the profile offers Suspend or Reactivate for this person, and why not when neither. */
export function accountAction(
  person: Pick<DirectoryPerson, "id" | "state" | "scope">,
  viewerId: string,
): "suspend" | "reactivate" | "none-self" | "none-no-access" {
  if (person.state === "suspended") return "reactivate";
  if (person.id === viewerId) return "none-self";
  return person.scope === "none" ? "none-no-access" : "suspend";
}

/** What suspending does, said before it is confirmed. */
export function suspendEffect(
  person: Pick<DirectoryPerson, "label" | "id" | "scope" | "admittedClients" | "isAdmin">,
  grants: readonly Pick<SubjectGrant, "role">[],
): string {
  const who = personLabel(person);
  const parts = [
    `${who} can't sign in to ${person.scope === "global" ? "any app" : `${person.admittedClients.join(", ")}`} from now on, and every session they have ends now.`,
    "Their roles stay stored but give them nothing while they are suspended.",
  ];
  if (person.isAdmin) parts.push("They are an identity admin: they lose identity administration too.");
  if (grants.some((g) => g.role === "core.admin")) parts.push("They hold core.admin: they lose this console too.");
  parts.push("You can reactivate them at any time.");
  return parts.join(" ");
}

/** What reactivating does: a global connection again, or only the per-app admissions of a public sign-up. */
export function reactivateEffect(
  person: Pick<DirectoryPerson, "label" | "id" | "admittedClients">,
  connectionSource: "admin" | "bootstrap" | "suspension" | null,
): string {
  const who = personLabel(person);
  return connectionSource === "suspension"
    ? `${who} can sign in again to the apps they were admitted to (${person.admittedClients.join(", ") || "none"}), and nothing more.`
    : `${who} gets an approved connection again: they can sign in to every app, with the roles they hold.`;
}
