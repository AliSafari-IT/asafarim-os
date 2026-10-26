/**
 * The gate of every page: not signed in → 401 (app/unauthorized.tsx), signed in without `flow.read` →
 * 403 (app/forbidden.tsx). Otherwise the subject and what else they may do, for the page's buttons; or
 * the reason nothing can be shown (app inactive, permissions unavailable).
 */
import { forbidden, unauthorized } from "next/navigation";
import { describeAccess, gate } from "./gate";

export type PageAccess = { ok: true; subject: string; permissions: string[] } | { ok: false; message: string };

export async function pageAccess(): Promise<PageAccess> {
  const g = await gate("flow.read");
  if (!g.ok && g.status === 401) unauthorized();
  if (!g.ok && g.status === 403) forbidden();
  if (!g.ok) return { ok: false, message: g.body.message };
  const access = await describeAccess(g.subject);
  return { ok: true, subject: g.subject, permissions: access.permissions };
}
