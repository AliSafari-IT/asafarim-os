/**
 * The console's read of identity's sign-in trail (core/identity src/audit-api.ts): who signed in, who failed,
 * who asked for access and who decided. Called like core-api, with the signed-in administrator's own ID token
 * as `Bearer`; identity checks the token and that the person is an identity admin. The console holds no
 * secret for it.
 *
 * Identity answers 404 when it runs without its own sign-in (login delegated to Hub), and older identity
 * images don't have the API at all: both read as "not available", never as an error page.
 */
import { CoreApiError } from "./core-api";

export interface SignInEvent {
  id: number;
  at: string;
  event: string;
  method: string | null;
  principalId: string | null;
  actorId: string | null;
  /** The person's email (else phone), so an admin recognises them. */
  label: string | null;
  actorLabel: string | null;
  /** HMACs, never the identifier or the address itself: the same value means the same address / identifier. */
  subjectHandle: string | null;
  ipHandle: string | null;
  detail: Record<string, unknown>;
}

export interface SignInFilter {
  /** Events and kinds (`request.`), any of them. */
  events?: readonly string[];
  method?: string;
  principal?: string;
  handle?: string;
  since?: string;
  until?: string;
  before?: number;
  limit?: number;
}

export interface SignInSummary {
  days: number;
  since: string;
  total: number;
  byDay: { day: string; total: number; events: Record<string, number> }[];
  byEvent: Record<string, number>;
  pendingRequests: number;
  activeConnections: number;
}

/** Account state as identity reports it: a revoked connection is a suspension. */
export type AccountState = "active" | "suspended";
/** Every app (a global connection), only the apps it was admitted to, or nothing yet. */
export type AdmissionScope = "global" | "apps" | "none";

/** One person in identity's directory (core/identity `GET /admin/v1/users`). */
export interface DirectoryPerson {
  /** The stable account id (`sub`): the join key everywhere. Email and labels can change. */
  id: string;
  /** Their email, else Google address, else phone number; null if none. */
  label: string | null;
  email: string | null;
  /** true: stored proof; false: an address without proof; null: no email to verify. */
  emailVerified: boolean | null;
  state: AccountState;
  scope: AdmissionScope;
  /** Clients (apps) a per-app public admission covers. */
  admittedClients: string[];
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface DirectoryFilter {
  q?: string;
  state?: AccountState;
  scope?: AdmissionScope;
  after?: string;
  limit?: number;
}

/** One person's profile (`GET /admin/v1/users/<id>`). */
export interface PersonProfile extends DirectoryPerson {
  identities: {
    method: "phone" | "email" | "google";
    identifier: string | null;
    verifiedAt: string | null;
    lastLoginAt: string | null;
    createdAt: string;
  }[];
  passkeys: number;
  connection: {
    status: "active" | "revoked";
    source: "admin" | "bootstrap" | "suspension" | null;
    grantedAt: string;
    grantedBy: string | null;
    revokedAt: string | null;
    revokedBy: string | null;
  } | null;
  admissions: { clientId: string; source: string; grantedAt: string }[];
  pendingRequest: { id: string; apps: string[]; note: string | null; createdAt: string } | null;
}

/** identity's public URL: the console's OIDC issuer. */
export const identityBase = () => (process.env.OIDC_ISSUER ?? "http://localhost:4010").replace(/\/$/, "");

/** identity's own admin page, where requests are approved and connections revoked. */
export const identityAdminUrl = () => `${identityBase()}/admin`;

async function call<T>(idToken: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${identityBase()}${path}`, {
      headers: { authorization: `Bearer ${idToken}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new CoreApiError(0, "unreachable", "identity isn't reachable right now.");
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok)
    throw new CoreApiError(res.status, payload.error ?? "error", payload.message ?? `identity answered ${res.status}`);
  return payload as T;
}

export function identityApi(idToken: string) {
  return {
    audit: (f: SignInFilter = {}) => {
      const q = new URLSearchParams();
      if (f.events?.length) q.set("event", f.events.join(","));
      if (f.method) q.set("method", f.method);
      if (f.principal) q.set("principal", f.principal);
      if (f.handle) q.set("handle", f.handle);
      if (f.since) q.set("since", f.since);
      if (f.until) q.set("until", f.until);
      if (f.before) q.set("before", String(f.before));
      if (f.limit) q.set("limit", String(f.limit));
      return call<{ events: SignInEvent[]; next: number | null }>(idToken, `/admin/v1/audit?${q}`);
    },
    summary: (days = 14) => call<SignInSummary>(idToken, `/admin/v1/audit/summary?days=${days}`),
    /** The people directory, one page at a time. */
    users: (f: DirectoryFilter = {}) => {
      const q = new URLSearchParams();
      if (f.q) q.set("q", f.q);
      if (f.state) q.set("state", f.state);
      if (f.scope) q.set("scope", f.scope);
      if (f.after) q.set("after", f.after);
      if (f.limit) q.set("limit", String(f.limit));
      return call<{ users: DirectoryPerson[]; next: string | null }>(idToken, `/admin/v1/users?${q}`);
    },
    /** One person; CoreApiError 404 when identity has no such account. */
    user: (id: string) => call<PersonProfile>(idToken, `/admin/v1/users/${encodeURIComponent(id)}`),
  };
}

export type TrailState = "ok" | "not-admin" | "unavailable";

/** Why the directory couldn't be read, in the page's terms (the same rules as the trail). */
export const directoryState = (err: unknown): Exclude<TrailState, "ok"> => trailState(err);

/** Why the trail couldn't be read, in the page's terms. */
export function trailState(err: unknown): Exclude<TrailState, "ok"> {
  return err instanceof CoreApiError && err.status === 403 ? "not-admin" : "unavailable";
}
