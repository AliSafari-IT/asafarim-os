/**
 * One place that decides what a request may do (P3.2): signed in? app active?
 * does the person hold the permission? The permission comes from core-api via
 * the SDK (granted by an admin), never from the sign-in token.
 */
import { isAccessUnavailableError, isForbiddenError } from "@asafarim/app-sdk";
import { auth } from "./auth";
import { getPlatform } from "./platform";

export type GateResult =
  | { ok: true; subject: string; roles: string[] }
  | {
      ok: false;
      status: 401 | 403 | 503;
      body: { error: string; permission?: string; state?: string; message: string };
    };

export async function gate(permission: string): Promise<GateResult> {
  const session = await auth();
  const subject = session?.user?.id;
  if (!subject) return { ok: false, status: 401, body: { error: "unauthenticated", message: "Sign in first." } };

  try {
    const platform = getPlatform();
    // The app's state comes first: an inactive app answers 503 whatever the person may do.
    const access = await platform.access.access(subject);
    if (access.state !== "active") {
      return {
        ok: false,
        status: 503,
        body: { error: "app_inactive", state: access.state, message: `The app is ${access.state}.` },
      };
    }
    await platform.access.require(session, permission); // throws ForbiddenError naming the permission (cached lookup)
    return { ok: true, subject, roles: access.roles };
  } catch (err) {
    if (isForbiddenError(err)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "forbidden",
          permission: err.permission,
          message: `Forbidden: requires the permission "${err.permission}".`,
        },
      };
    }
    if (isAccessUnavailableError(err)) {
      return {
        ok: false,
        status: 503,
        body: { error: "permissions_unavailable", message: "Permissions can't be checked right now." },
      };
    }
    throw err;
  }
}

/** The app's state and the subject's permissions, for the page (no permission required). */
export async function describeAccess(subject: string) {
  try {
    return { available: true as const, ...(await getPlatform().access.access(subject)) };
  } catch {
    return { available: false as const, state: "unknown", roles: [] as string[], permissions: [] as string[] };
  }
}
