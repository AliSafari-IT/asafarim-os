/**
 * The gateway's decision (P3.3a, ADR 0001 §3/§7): Caddy's `forward_auth` asks
 * `GET /authz/check` about EVERY request to an app's host, and this answers
 * 200 (pass it to the app) or the response the visitor should see instead.
 *
 *   app not active (or not installed)          503  the styled "unavailable" page, no proxy
 *   path the manifest hides (expose: false)    404
 *   path no route puts a permission on         200  public: the app decides (and re-checks)
 *   route needs a permission, no valid token   401  (a browser page → 302 to the app's session endpoint)
 *   token valid, permission missing            403  naming the permission
 *   token valid, permission held               200
 *
 * It never reads the database per request: the app table is a short-lived
 * in-process snapshot, dropped on every lifecycle change, and the token is
 * verified locally (@asafarim/registry-protocol) with no clock-skew allowance: this
 * process issued it, so a token is good for exactly its lifetime and not a second more. Which app a request is for
 * comes from the generated Caddy config (`X-Asafarim-App`), not from the host.
 */
import type { AppManifest } from "@asafarim/app-manifest";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_SESSION_PATH,
  verifyAccessToken,
  type TokenProblem,
  type VerificationKey,
} from "@asafarim/registry-protocol";

export type GatewayState = "installed" | "active" | "inactive" | "removed";

export interface GatewayApp {
  id: string;
  state: GatewayState;
  manifest: Pick<AppManifest, "name" | "routes">;
}

export interface AuthzRequest {
  /** X-Asafarim-App, set by the generated Caddy site block. */
  appId?: string;
  /** X-Forwarded-Method */
  method?: string;
  /** X-Forwarded-Uri: the original path and query. */
  uri?: string;
  cookie?: string;
  accept?: string;
}

export interface AuthzResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface GatewayDeps {
  /** The apps, as of now or a moment ago (see `createAppSnapshot`). */
  apps: () => Promise<GatewayApp[]>;
  /** The keys tokens may be signed with. */
  keys: () => VerificationKey[];
  now?: () => Date;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** `*` is one path segment, `**` any depth. A trailing `/**` also matches the bare directory. */
export function routeRegex(pattern: string): RegExp {
  const re = pattern
    .split("/**")
    .map((part) =>
      part
        .split("*")
        .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join("(?:/.*)?");
  return new RegExp(`^${re}$`);
}

const regexCache = new Map<string, RegExp>();
const regexFor = (pattern: string) => {
  let re = regexCache.get(pattern);
  if (!re) regexCache.set(pattern, (re = routeRegex(pattern)));
  return re;
};

/**
 * The path as the gateway and the app might each read it: as sent, and
 * percent-decoded with dot segments and doubled slashes resolved. Route rules
 * are matched against both, so `/internal/%2e%2e/x` or `//internal` can't slip
 * past a rule for `/internal/**`.
 */
export function pathForms(pathname: string): string[] {
  const forms = new Set([pathname]);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname; // a malformed escape: only the raw form can match
  }
  const out: string[] = [];
  for (const seg of decoded.split(/[/\\]+/)) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  forms.add(`/${out.join("/")}`);
  return [...forms];
}

export interface RouteVerdict {
  hidden: boolean;
  permissions: string[];
}

/** What the manifest's routes say about this request, over every reading of the path. */
export function routeVerdict(routes: AppManifest["routes"], method: string, pathname: string): RouteVerdict {
  const permissions = new Set<string>();
  let hidden = false;
  for (const form of pathForms(pathname)) {
    for (const r of routes ?? []) {
      if (r.methods && !r.methods.includes(method as never)) continue;
      if (!regexFor(r.path).test(form)) continue;
      if (r.expose === false) hidden = true;
      else if (r.permission) permissions.add(r.permission);
    }
  }
  return { hidden, permissions: [...permissions].sort() };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--muted:#555;--accent:#7c3aed}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#f2f2f3;--muted:#a1a1aa;--accent:#a78bfa}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:34rem;padding:2rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.25rem 0;color:var(--muted)}
code{color:var(--accent)}`;

function page(title: string, lines: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${l}</p>`).join("")}</main></body></html>`;
}

const NO_STORE = { "cache-control": "no-store" };

function respond(
  status: number,
  wantsHtml: boolean,
  json: Record<string, unknown>,
  html: { title: string; lines: string[] },
  extra: Record<string, string> = {},
): AuthzResponse {
  return wantsHtml
    ? {
        status,
        headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8", ...extra },
        body: page(html.title, html.lines),
      }
    : { status, headers: { ...NO_STORE, "content-type": "application/json", ...extra }, body: JSON.stringify(json) };
}

const problemError = (p: TokenProblem) => (p === "expired" ? "token_expired" : "invalid_token");

export function createGateway(deps: GatewayDeps) {
  const now = deps.now ?? (() => new Date());

  async function check(req: AuthzRequest): Promise<AuthzResponse> {
    const method = (req.method ?? "GET").toUpperCase();
    const wantsHtml = (method === "GET" || method === "HEAD") && /\btext\/html\b/.test(req.accept ?? "");
    const appId = req.appId ?? "";

    // The forwarded URI is a path and query, NOT a URL: `new URL("//internal/x", base)` would read
    // "internal" as a host and drop it from the path, so split by hand.
    const uri = req.uri ?? "/";
    if (!uri.startsWith("/")) {
      return respond(404, wantsHtml, { error: "not_found" }, { title: "Not found", lines: ["There is nothing here."] });
    }
    const cut = uri.search(/[?#]/);
    const target = { pathname: cut === -1 ? uri : uri.slice(0, cut), search: cut === -1 ? "" : uri.slice(cut) };

    const app = (await deps.apps()).find((a) => a.id === appId);
    if (!app || app.state !== "active") {
      const name = app?.manifest.name ?? "This app";
      return respond(
        503,
        wantsHtml,
        { error: "app_inactive", state: app?.state ?? "not_installed" },
        {
          title: `${name} is temporarily unavailable`,
          lines: ["It has been switched off by an administrator. Its data is kept.", "Please try again later."],
        },
        { "retry-after": "60" },
      );
    }

    const verdict = routeVerdict(app.manifest.routes, method, target.pathname);
    if (verdict.hidden) {
      return respond(404, wantsHtml, { error: "not_found" }, { title: "Not found", lines: ["There is nothing here."] });
    }
    if (verdict.permissions.length === 0) return { status: 200, headers: NO_STORE, body: "" };

    const token = cookieValue(req.cookie, ACCESS_COOKIE_NAME);
    const result = token
      ? verifyAccessToken(token, { keys: deps.keys(), audience: app.id, now: now(), skewSeconds: 0 })
      : ({ ok: false, reason: "missing" } as const);
    if (!result.ok) {
      const error = result.reason === "missing" ? "unauthenticated" : problemError(result.reason);
      if (wantsHtml) {
        // A page: send the browser to the app, which signs the person in if needed and re-issues the token.
        const next = encodeURIComponent(`${target.pathname}${target.search}`);
        return { status: 302, headers: { ...NO_STORE, location: `${ACCESS_SESSION_PATH}?next=${next}` }, body: "" };
      }
      return respond(401, false, { error, refresh: ACCESS_SESSION_PATH }, { title: "", lines: [] });
    }

    const missing = verdict.permissions.find((p) => !result.claims.perms.includes(p));
    if (missing) {
      return respond(
        403,
        wantsHtml,
        { error: "forbidden", permission: missing },
        {
          title: "You don't have access",
          lines: [
            `This needs the permission <code>${escapeHtml(missing)}</code>. Ask an administrator for a role that grants it.`,
          ],
        },
      );
    }
    return { status: 200, headers: NO_STORE, body: "" };
  }

  return { check };
}

export type Gateway = ReturnType<typeof createGateway>;

/**
 * A snapshot of the apps that is dropped on every lifecycle change and, as a
 * safety net, refreshed after `ttlMs`, so the gateway never works from stale
 * state for long and a request never costs a query.
 */
export function createAppSnapshot(
  load: () => Promise<GatewayApp[]>,
  opts: { ttlMs?: number; now?: () => number } = {},
) {
  const ttl = opts.ttlMs ?? 2000;
  const clock = opts.now ?? Date.now;
  let cached: { at: number; apps: Promise<GatewayApp[]> } | undefined;
  return {
    apps(): Promise<GatewayApp[]> {
      if (!cached || clock() - cached.at >= ttl) {
        const apps = load();
        const entry = { at: clock(), apps };
        cached = entry;
        // A failed load must not be served again: drop it, the next request tries again.
        apps.catch(() => {
          if (cached === entry) cached = undefined;
        });
      }
      return cached.apps;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
