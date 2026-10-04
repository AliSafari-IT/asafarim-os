/**
 * An internal probe (P3.3a): it exists so the gateway's `expose: false` rule
 * (platform.app.ts: /internal/**) is tested against a path the app really
 * serves. Reached directly it answers; through the OS gateway it is a 404.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, internal: true });
}
