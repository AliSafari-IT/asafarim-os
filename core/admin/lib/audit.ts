/**
 * How the Audit pages read the two trails (pure, unit-tested in test/audit.test.ts):
 *
 *  - **Admin changes**: core-api's `audit_events`, every change made on an administrator's (or an app's) say-so.
 *  - **Sign-ins & access**: identity's `audit_log`, who signed in, who failed, who asked for access and who decided.
 *
 * Each event becomes a kind, a tone (good / info / warn / bad, always shown as text too, never colour only) and
 * one plain sentence. The CSV export and the overview's "Needs attention" list are built here as well.
 */
import type { AuditEvent } from "./core-api";
import type { SignInEvent } from "./identity-api";

export type Tone = "good" | "info" | "warn" | "bad";

export interface Described {
  /** The filter group it belongs to (`roles`, `failures`…). */
  kind: string;
  /** A short name for the badge. */
  label: string;
  tone: Tone;
  /** One plain sentence: what happened. */
  sentence: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A long id shortened for a sentence (the full one stays in the row's detail): "0190b6c4…". */
export const shortSubject = (s: string) => (s.length > 20 && /^[0-9a-f-]+$/i.test(s) ? `${s.slice(0, 8)}…` : s);

/** "user:8cc8…" → the subject, "admin" → the command line, "app:notes" → the app. */
export function actorName(actor: string): string {
  if (actor === "admin") return "the command line (admin token)";
  if (actor.startsWith("user:")) return shortSubject(actor.slice(5));
  if (actor.startsWith("app:")) return `the app ${actor.slice(4)}`;
  return actor;
}

/* ------------------------------------------------------------------ admin changes (core-api) */

/** The kinds the Admin changes page filters by: core-api's action prefixes. */
export const CHANGE_KINDS = [
  { value: "app.", label: "Apps (install, activate, remove…)" },
  { value: "role.", label: "Roles & grants" },
  { value: "event_schemas.", label: "Event schemas" },
] as const;

/** Every action core-api writes (core/core-api/src/registry.ts), for the action filter. */
export const CHANGE_ACTIONS = [
  "app.installed",
  "app.registered",
  "app.activated",
  "app.deactivated",
  "app.removed",
  "app.purged",
  "event_schemas.updated",
  "role.granted",
  "role.revoked",
] as const;

/** The role that runs the whole platform: granting or revoking it always deserves a look. */
export const CORE_ADMIN = "core.admin";

export function describeChange(e: Pick<AuditEvent, "action" | "appId" | "detail" | "actor">): Described {
  const d = e.detail ?? {};
  const app = e.appId ?? "an app";
  const role = str(d.role);
  const full = str(d.subject);
  const subject = full && shortSubject(full);
  switch (e.action) {
    case "app.installed":
      return {
        kind: "apps",
        label: "Installed",
        tone: "info",
        sentence: `Installed ${app}${str(d.version) ? ` ${d.version}` : ""}.`,
      };
    case "app.registered":
      return {
        kind: "apps",
        label: "Registered",
        tone: "info",
        sentence: `${app} registered itself${str(d.version) ? ` (version ${d.version})` : ""}.`,
      };
    case "app.activated":
      return {
        kind: "apps",
        label: "Activated",
        tone: "good",
        sentence: `Activated ${app}: it's served and in launchers.`,
      };
    case "app.deactivated":
      return {
        kind: "apps",
        label: "Deactivated",
        tone: "warn",
        sentence: `Deactivated ${app}: it shows "temporarily unavailable".`,
      };
    case "app.removed":
      return {
        kind: "apps",
        label: "Removed",
        tone: "bad",
        sentence: `Removed ${app}: credentials, grants and event plumbing gone; database backed up.`,
      };
    case "app.purged":
      return { kind: "apps", label: "Purged", tone: "bad", sentence: `Purged ${app}'s database and its role.` };
    case "event_schemas.updated": {
      const types = Array.isArray(d.types) ? d.types.length : undefined;
      return {
        kind: "schemas",
        label: "Schemas",
        tone: "info",
        sentence: `${app} uploaded ${types === undefined ? "its" : `${types}`} event schema${types === 1 ? "" : "s"}.`,
      };
    }
    case "role.granted":
      return {
        kind: "roles",
        label: "Granted",
        tone: role === CORE_ADMIN ? "warn" : "good",
        sentence: `Granted ${role ?? "a role"} to ${subject ?? "someone"}${role === CORE_ADMIN ? ": full platform administrator" : ""}.`,
      };
    case "role.revoked":
      return {
        kind: "roles",
        label: "Revoked",
        tone: role === CORE_ADMIN ? "warn" : "info",
        sentence: `Revoked ${role ?? "a role"} from ${subject ?? "someone"}.`,
      };
    default:
      return { kind: "other", label: e.action, tone: "info", sentence: `${e.action} on ${app}.` };
  }
}

/** Changes that deserve an administrator's second look: platform-admin grants, removals and purges. */
export function isSensitiveChange(e: Pick<AuditEvent, "action" | "detail">): boolean {
  if (e.action === "app.removed" || e.action === "app.purged") return true;
  return (e.action === "role.granted" || e.action === "role.revoked") && e.detail?.role === CORE_ADMIN;
}

/* ------------------------------------------------------------- sign-ins & access (identity) */

/** The groups the Sign-ins page filters by, each a list of identity events or kinds (`request.`). */
export const SIGN_IN_KINDS = [
  { value: "signins", label: "Successful sign-ins", events: ["login.granted"] },
  {
    value: "failures",
    label: "Failed or refused",
    events: [
      "otp.verify_failed",
      "otp.verify_refused",
      "otp.send_refused",
      "otp.send_failed",
      "passkey.failed",
      "google.failed",
      "login.not_authorized",
    ],
  },
  { value: "codes", label: "Codes and proofs", events: ["otp.sent", "otp.verified", "google.verified"] },
  { value: "access", label: "Access requests", events: ["request."] },
  { value: "connections", label: "Connections (granted, revoked)", events: ["connection."] },
  { value: "passkeys", label: "Passkeys", events: ["passkey.registered", "passkey.removed"] },
  { value: "admin", label: "Refused admin access", events: ["admin.denied"] },
  { value: "logout", label: "Sign-outs", events: ["logout"] },
] as const;

export type SignInKind = (typeof SIGN_IN_KINDS)[number]["value"];

/** Which group an identity event belongs to (`failures`, `access`…), or `other` for one this console doesn't know. */
export function signInKindOf(event: string): SignInKind | "other" {
  for (const k of SIGN_IN_KINDS) {
    if ((k.events as readonly string[]).some((e) => (e.endsWith(".") ? event.startsWith(e) : event === e)))
      return k.value;
  }
  return "other";
}

export const METHODS = [
  { value: "email", label: "Email code" },
  { value: "sms", label: "SMS code" },
  { value: "passkey", label: "Passkey" },
  { value: "google", label: "Google" },
] as const;

export const methodLabel = (m: string | null | undefined) =>
  (m && METHODS.find((x) => x.value === m)?.label) ?? (m || "—");

const reasonOf = (d: Record<string, unknown>) => str(d.reason) ?? str(d.code) ?? str(d.error);

export function describeSignIn(
  e: Pick<SignInEvent, "event" | "method" | "detail" | "actorLabel" | "actorId">,
): Described {
  const d = e.detail ?? {};
  const kind = signInKindOf(e.event);
  const by = e.actorLabel ?? (e.actorId ? `an admin (${e.actorId.slice(0, 8)}…)` : "an admin");
  const via = e.method ? ` with ${methodLabel(e.method).toLowerCase()}` : "";
  const reason = reasonOf(d);
  const why = reason ? ` (${reason.replaceAll("_", " ")})` : "";
  const apps = str(d.apps);
  switch (e.event) {
    case "login.granted": {
      const client = str(d.clientId);
      if (d.via === "session")
        return {
          kind,
          label: "Signed in",
          tone: "good",
          sentence: `Signed in to ${client ?? "an app"} with their open session.`,
        };
      return { kind, label: "Signed in", tone: "good", sentence: `Signed in${via}.` };
    }
    case "login.not_authorized":
      return {
        kind,
        label: "No access",
        tone: "warn",
        sentence: `Proved who they are${via}, but has no access yet: they were offered to request it.`,
      };
    case "otp.sent":
      return {
        kind,
        label: "Code sent",
        tone: "info",
        sentence: `A sign-in code was sent${e.method === "sms" ? " by SMS" : " by email"}.`,
      };
    case "otp.send_failed":
      return { kind, label: "Send failed", tone: "warn", sentence: `The sign-in code couldn't be sent${why}.` };
    case "otp.send_refused":
      return {
        kind,
        label: "Send refused",
        tone: "warn",
        sentence: `Sending a code was refused${why || " (rate limit)"}.`,
      };
    case "otp.verify_failed":
      return { kind, label: "Wrong code", tone: "warn", sentence: `A wrong or expired code was entered${why}.` };
    case "otp.verify_refused":
      return {
        kind,
        label: "Locked out",
        tone: "bad",
        sentence: `Code checks were refused${why || " (too many tries)"}.`,
      };
    case "otp.verified":
      return { kind, label: "Code OK", tone: "info", sentence: `Their code was accepted${via}.` };
    case "google.verified":
      return { kind, label: "Google OK", tone: "info", sentence: "Google confirmed their account." };
    case "google.failed":
      return { kind, label: "Google failed", tone: "warn", sentence: `Google sign-in didn't complete${why}.` };
    case "passkey.failed":
      return { kind, label: "Passkey failed", tone: "warn", sentence: `A passkey sign-in failed${why}.` };
    case "passkey.registered":
      return { kind, label: "Passkey added", tone: "info", sentence: "Added a passkey to their account." };
    case "passkey.removed":
      return { kind, label: "Passkey removed", tone: "warn", sentence: "Removed a passkey from their account." };
    case "request.created":
      return {
        kind,
        label: "Requested",
        tone: "info",
        sentence: `Asked for access${apps ? ` to ${apps.split(",").join(", ")}` : ""}: waiting for an admin.`,
      };
    case "request.updated":
      return { kind, label: "Request changed", tone: "info", sentence: "Changed their pending access request." };
    case "request.approved":
      return { kind, label: "Approved", tone: "good", sentence: `Access approved by ${by}.` };
    case "request.rejected":
      return { kind, label: "Rejected", tone: "warn", sentence: `Access request rejected by ${by}.` };
    case "connection.added":
      return {
        kind,
        label: d.reconnect ? "Reconnected" : "Connected",
        tone: "good",
        sentence: `${d.reconnect ? "Reconnected" : "Connected"} by ${by}.`,
      };
    case "connection.revoked":
      return { kind, label: "Revoked", tone: "bad", sentence: `Access revoked by ${by}; their sessions ended.` };
    case "connection.bootstrapped":
      return {
        kind,
        label: "Bootstrap",
        tone: "warn",
        sentence: "Made the first identity admin (bootstrap from the server's settings).",
      };
    case "admin.denied":
      return {
        kind,
        label: "Admin refused",
        tone: "bad",
        sentence:
          d.via === "audit_api"
            ? "Tried to read the sign-in trail without being an identity admin."
            : "Tried to open identity's admin page without being an admin.",
      };
    case "logout":
      return { kind, label: "Signed out", tone: "info", sentence: "Signed out." };
    default:
      return { kind, label: e.event, tone: "info", sentence: e.event };
  }
}

/* ------------------------------------------------------------------------- overview */

export interface DayBuckets {
  day: string;
  signins: number;
  failures: number;
  access: number;
  changes: number;
}

/** Sign-in events per day folded into the chart's four series (core-api's changes are added by `withChanges`). */
export function signInSeries(byDay: { day: string; events: Record<string, number> }[]): DayBuckets[] {
  return byDay.map(({ day, events }) => {
    const b: DayBuckets = { day, signins: 0, failures: 0, access: 0, changes: 0 };
    for (const [event, n] of Object.entries(events)) {
      const k = signInKindOf(event);
      if (k === "signins") b.signins += n;
      else if (k === "failures" || k === "admin") b.failures += n;
      else if (k === "access" || k === "connections") b.access += n;
    }
    return b;
  });
}

/** Adds core-api's per-day totals to the chart's days (matching by date; days only one side has are kept). */
export function withChanges(days: DayBuckets[], changes: { day: string; total: number }[]): DayBuckets[] {
  const out = new Map(days.map((d) => [d.day, { ...d }]));
  for (const c of changes) {
    const d = out.get(c.day) ?? { day: c.day, signins: 0, failures: 0, access: 0, changes: 0 };
    d.changes += c.total;
    out.set(c.day, d);
  }
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface Attention {
  tone: Tone;
  text: string;
  href?: string;
  link?: string;
}

/**
 * The overview's "Needs attention": waiting requests, a spike of failed sign-ins today (more than 10 and more
 * than three times the daily average before it), refused admin access, platform-admin grants, removals.
 */
export function attention(input: {
  pendingRequests?: number;
  days?: DayBuckets[];
  deniedAdmin?: number;
  sensitiveChanges?: Pick<AuditEvent, "action" | "detail" | "appId" | "actor">[];
  identityAdminUrl?: string;
}): Attention[] {
  const out: Attention[] = [];
  const pending = input.pendingRequests ?? 0;
  if (pending > 0)
    out.push({
      tone: "warn",
      text: `${pending} ${pending === 1 ? "person is" : "people are"} waiting for access. Signing in isn't enough: an identity admin approves each request.`,
      ...(input.identityAdminUrl ? { href: input.identityAdminUrl, link: "Review requests" } : {}),
    });
  const days = input.days ?? [];
  const today = days.at(-1);
  if (today && days.length > 1) {
    const before = days.slice(0, -1);
    const avg = before.reduce((n, d) => n + d.failures, 0) / before.length;
    if (today.failures > 10 && today.failures > 3 * avg)
      out.push({
        tone: "bad",
        text: `${today.failures} failed sign-ins today, against about ${Math.round(avg)} a day before. Look for one address trying many codes.`,
        href: "/admin/audit/sign-ins?kind=failures",
        link: "See failures",
      });
  }
  if (input.deniedAdmin)
    out.push({
      tone: "warn",
      text: `${input.deniedAdmin} attempt${input.deniedAdmin === 1 ? "" : "s"} to open admin pages by someone who isn't an admin.`,
      href: "/admin/audit/sign-ins?kind=admin",
      link: "See who",
    });
  for (const c of input.sensitiveChanges ?? []) {
    out.push({
      tone: c.action.startsWith("role.") ? "warn" : "info",
      text: `${describeChange(c).sentence} By ${actorName(c.actor)}.`,
      href: `/admin/audit/changes?action=${c.action}`,
      link: "Details",
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------- CSV */

/**
 * One CSV cell: quoted when it must be, and a leading `=`, `+`, `-`, `@`, tab or CR neutralised with a `'` so a
 * spreadsheet never runs it as a formula (CSV injection).
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/* --------------------------------------------------------------------------- filters */

/** A `YYYY-MM-DD` date from a form field (the start of that UTC day), or undefined. */
export function dayParam(v: string | undefined): string | undefined {
  if (!v || !/^\d{4}-\d\d-\d\d$/.test(v)) return undefined;
  return Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? undefined : v;
}

/** The exclusive end of a "to" day: the next day's start, so "to 2026-10-26" includes all of the 26th. */
export function dayAfter(v: string): string {
  return new Date(new Date(`${v}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export const isHandle = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(v);
