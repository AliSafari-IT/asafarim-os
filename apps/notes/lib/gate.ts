/**
 * One place that decides what a request may do (P3.2): signed in? app active?
 * does the person hold the permission? The permission comes from core-api via
 * the SDK (granted by an admin), never from the sign-in token. When the OS
 * gateway issued the person's short-lived access token (P3.3a), the check uses
 * that token, so the app and the gateway agree and share its staleness bound.
 */
async function accessToken(): Promise<string | undefined> {
  return (await cookies()).get(ACCESS_COOKIE_NAME)?.value;
}

import { ACCESS_COOKIE_NAME, isAccessUnavailableError, isForbiddenError } from "@asafarim/app-sdk";
import { cookies } from "next/headers";
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
    const token = await accessToken();
    const access = await platform.access.access(subject, { token });
    if (access.state !== "active") {
      return {
        ok: false,
        status: 503,
        body: { error: "app_inactive", state: access.state, message: `The app is ${access.state}.` },
      };
    }
    await platform.access.require(session, permission, { token }); // throws ForbiddenError naming the permission
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
    return {
      available: true as const,
      ...(await getPlatform().access.access(subject, { token: await accessToken() })),
    };
  } catch {
    return { available: false as const, state: "unknown", roles: [] as string[], permissions: [] as string[] };
  }
}
