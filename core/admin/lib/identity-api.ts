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
  };
}

export type TrailState = "ok" | "not-admin" | "unavailable";

/** Why the trail couldn't be read, in the page's terms. */
export function trailState(err: unknown): Exclude<TrailState, "ok"> {
  return err instanceof CoreApiError && err.status === 403 ? "not-admin" : "unavailable";
}
