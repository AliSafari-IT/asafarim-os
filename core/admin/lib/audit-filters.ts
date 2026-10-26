/**
 * The Audit pages' filters, read from the query string (anything invalid is dropped, as if it wasn't given),
 * and the query strings that keep them across paging and the CSV export. Shared by the pages and the export
 * route, so a download always holds exactly what the page shows.
 */
import { CHANGE_ACTIONS, CHANGE_KINDS, SIGN_IN_KINDS, dayParam, isHandle, isUuid, METHODS } from "./audit";
import { isAppId, isSubject } from "./util";

type Params = Record<string, string | undefined>;

/** The filters, read from the query (anything invalid is dropped, as if not given). Shared with the CSV export. */
export function changeFilters(params: Params) {
  const app = isAppId(params.app) || params.app === "core" ? params.app : undefined;
  const actor = params.actor?.trim().slice(0, 128) || undefined;
  const action =
    (CHANGE_ACTIONS as readonly string[]).includes(params.action ?? "") ||
    CHANGE_KINDS.some((k) => k.value === params.action)
      ? params.action
      : undefined;
  const involving = isSubject(params.involving?.trim()) ? params.involving!.trim() : undefined;
  const from = dayParam(params.from);
  const to = dayParam(params.to);
  const before = /^\d{1,12}$/.test(params.before ?? "") ? Number(params.before) : undefined;
  return { app, actor, action, involving, from, to, before };
}

export function changeQuery(f: ReturnType<typeof changeFilters>, extra: Record<string, string> = {}) {
  const q = new URLSearchParams();
  for (const k of ["app", "actor", "action", "involving", "from", "to"] as const) if (f[k]) q.set(k, f[k]!);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

export function signInFilters(params: Params) {
  const kind = SIGN_IN_KINDS.find((k) => k.value === params.kind)?.value;
  const method = METHODS.find((m) => m.value === params.method)?.value;
  const principal = isUuid(params.principal) ? params.principal.toLowerCase() : undefined;
  const handle = isHandle(params.handle) ? params.handle : undefined;
  const from = dayParam(params.from);
  const to = dayParam(params.to);
  const before = /^\d{1,12}$/.test(params.before ?? "") ? Number(params.before) : undefined;
  return { kind, method, principal, handle, from, to, before };
}

export function signInQuery(f: ReturnType<typeof signInFilters>, extra: Record<string, string> = {}) {
  const q = new URLSearchParams();
  for (const k of ["kind", "method", "principal", "handle", "from", "to"] as const) if (f[k]) q.set(k, f[k]!);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}
