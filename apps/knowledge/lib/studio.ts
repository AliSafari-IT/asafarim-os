/**
 * The studio's gate: every studio page and action starts here. Signed in, the app active, and the
 * person holds `knowledge.content.create` (the gateway asks for the same permission on /studio/**);
 * the Actor it returns carries the person's Knowledge permissions for the per-item policy.
 */
import { forbidden, unauthorized } from "next/navigation";
import { gate } from "./gate";
import { PERMISSIONS, type Actor } from "./policy";

export type StudioGate = { ok: true; actor: Actor } | { ok: false; status: 401 | 403 | 503; error: string };

export async function studioGate(): Promise<StudioGate> {
  const g = await gate(PERMISSIONS.create);
  if (!g.ok) return { ok: false, status: g.status, error: g.body.error };
  return { ok: true, actor: { subject: g.subject, permissions: g.permissions } };
}

/** For pages: 401 and 403 render app/unauthorized.tsx and app/forbidden.tsx; 503 is returned for the page to explain. */
export async function requireStudio(): Promise<{ ok: true; actor: Actor } | { ok: false; error: string }> {
  const g = await studioGate();
  if (g.ok) return g;
  if (g.status === 401) unauthorized();
  if (g.status === 403) forbidden();
  return { ok: false, error: g.error };
}
