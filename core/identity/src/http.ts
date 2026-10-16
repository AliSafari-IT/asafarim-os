/** Small helpers over the Koa context oidc-provider hands to its middleware. */

/** The slice of a Koa context the service's own routes use. */
export interface HttpContext {
  method: string;
  path: string;
  query: Record<string, string | string[] | undefined>;
  ip: string;
  ips: string[];
  secure: boolean;
  status: number;
  type: string;
  body: unknown;
  req: AsyncIterable<unknown>;
  cookies: {
    get(name: string, opts?: { signed?: boolean }): string | undefined;
    set(name: string, value?: string | null, opts?: CookieOptions): unknown;
  };
  is(type: string): string | false | null;
  set(field: string, value: string): void;
  redirect(url: string): void;
}

export interface CookieOptions {
  path?: string;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  maxAge?: number;
  signed?: boolean;
  overwrite?: boolean;
}

export const MAX_FORM_BYTES = 16 * 1024;

/** An urlencoded form body (at most 16 KiB), or null. */
export async function readForm(ctx: Pick<HttpContext, "is" | "req">): Promise<URLSearchParams | null> {
  if (!ctx.is("application/x-www-form-urlencoded")) return null;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function sendHtml(ctx: Pick<HttpContext, "status" | "type" | "body" | "set">, status: number, html: string) {
  ctx.status = status;
  ctx.type = "html";
  ctx.set("Cache-Control", "no-store");
  ctx.body = html;
}

/**
 * The client's address. Behind the edge Caddy (`IDENTITY_TRUST_PROXY`), the
 * RIGHTMOST X-Forwarded-For entry is the one the proxy itself appended; the
 * ones to its left come from the client and can be forged, so they never
 * key a rate limit.
 */
export function clientIp(ctx: Pick<HttpContext, "ip" | "ips">): string {
  const ips = ctx.ips ?? [];
  return ips.length ? ips[ips.length - 1]! : ctx.ip;
}

/** A single query value (the first, if repeated). */
export function queryValue(ctx: Pick<HttpContext, "query">, name: string): string | undefined {
  const v = ctx.query[name];
  return Array.isArray(v) ? v[0] : v;
}
