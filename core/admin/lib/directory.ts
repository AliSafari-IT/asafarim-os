/**
 * The Users directory's URLs: the filters and the page cursor are in the URL (no personal data), the search text
 * is not (app/admin/users/actions.ts keeps it in a cookie). `back` links from a profile return here exactly.
 */
export const USERS_QUERY_COOKIE = "admin-users-q";

export interface DirectoryView {
  state?: string | undefined;
  scope?: string | undefined;
  after?: string | undefined;
}

const STATE = /^(active|suspended)$/;
const SCOPE = /^(global|apps|none)$/;
const CURSOR = /^[A-Za-z0-9_-]{1,1000}$/;

/** The view the URL asks for, with anything malformed dropped. */
export function parseView(params: Record<string, string | undefined>): DirectoryView {
  const v: DirectoryView = {};
  if (params.state && STATE.test(params.state)) v.state = params.state;
  if (params.scope && SCOPE.test(params.scope)) v.scope = params.scope;
  if (params.after && CURSOR.test(params.after)) v.after = params.after;
  return v;
}

export function directoryHref(v: DirectoryView): string {
  const q = new URLSearchParams();
  if (v.state) q.set("state", v.state);
  if (v.scope) q.set("scope", v.scope);
  if (v.after) q.set("after", v.after);
  const s = q.toString();
  return s ? `/admin/users?${s}` : "/admin/users";
}

/** Only a path back to the directory itself: never another site or another admin page. */
export function safeBack(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/admin/users")) return "/admin/users";
  try {
    const url = new URL(raw, "http://admin.invalid");
    if (url.origin !== "http://admin.invalid" || url.pathname !== "/admin/users") return "/admin/users";
    return directoryHref(parseView(Object.fromEntries(url.searchParams)));
  } catch {
    return "/admin/users";
  }
}
