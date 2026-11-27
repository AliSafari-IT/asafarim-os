"use server";

/**
 * The Users directory's search. The search text can be someone's email address, so it never goes into a URL (no
 * browser history, no server logs, no Referer): it is kept in a short-lived, httpOnly cookie scoped to the Users
 * pages, and the page reads it from there. The filters (state, scope) carry no personal data and stay in the URL,
 * so returning to the directory restores them.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CoreApiError } from "@/lib/core-api";
import { identityApi } from "@/lib/identity-api";
import { requireAdmin } from "@/lib/session";
import { isSubject, withMessage } from "@/lib/util";
import { directoryHref, USERS_QUERY_COOKIE } from "@/lib/directory";

const STATES = new Set(["active", "suspended"]);
const SCOPES = new Set(["global", "apps", "none"]);

const pick = (v: FormDataEntryValue | null, allowed: Set<string>) =>
  typeof v === "string" && allowed.has(v) ? v : undefined;

export async function searchDirectory(formData: FormData) {
  await requireAdmin();
  const raw = formData.get("q");
  const q = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
  const jar = await cookies();
  if (q) {
    jar.set(USERS_QUERY_COOKIE, q, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/admin/users",
      maxAge: 30 * 60,
    });
  } else {
    jar.delete({ name: USERS_QUERY_COOKIE, path: "/admin/users" });
  }
  redirect(directoryHref({ state: pick(formData.get("state"), STATES), scope: pick(formData.get("scope"), SCOPES) }));
}

export async function clearDirectory() {
  await requireAdmin();
  (await cookies()).delete({ name: USERS_QUERY_COOKIE, path: "/admin/users" });
  redirect("/admin/users");
}

/** Open a person by their exact account id (when the directory can't be listed, or for a known id). */
export async function openPerson(formData: FormData) {
  await requireAdmin();
  const raw = formData.get("subject");
  const subject = typeof raw === "string" ? raw.trim() : "";
  if (!isSubject(subject)) redirect("/admin/users?error=That+isn%27t+an+account+id.");
  redirect(`/admin/users/${encodeURIComponent(subject)}`);
}

const REFUSED: Record<string, string> = {
  self: "You can't suspend your own account.",
  last_admin: "That is the last identity admin with access. Make someone else an identity admin first.",
  no_access: "That account has no access to suspend.",
  not_found: "Identity has no such account.",
  forbidden: "Only an identity admin can do that.",
};

/** Suspend or reactivate, through identity (which owns account state, checks the caller and audits it). */
async function accountAction(formData: FormData, action: "suspend" | "reactivate") {
  const admin = await requireAdmin();
  const raw = formData.get("subject");
  const subject = typeof raw === "string" ? raw.trim() : "";
  if (!isSubject(subject)) redirect("/admin/users?error=That+isn%27t+an+account+id.");
  const back = `/admin/users/${encodeURIComponent(subject)}`;
  let result: { kind: "notice" | "error"; message: string };
  try {
    const api = identityApi(admin.idToken);
    if (action === "suspend") {
      const r = await api.suspend(subject);
      result = {
        kind: "notice",
        message:
          r.outcome === "already"
            ? "Already suspended: nothing changed."
            : `Suspended. ${r.sessionsEnded ?? 0} session${r.sessionsEnded === 1 ? "" : "s"} ended.`,
      };
    } else {
      const r = await api.reactivate(subject);
      result = {
        kind: "notice",
        message:
          r.outcome === "not_suspended"
            ? "Not suspended: nothing changed."
            : r.outcome === "admissions_restored"
              ? "Reactivated: their per-app admissions apply again."
              : "Reactivated: they can sign in to every app again.",
      };
    }
  } catch (err) {
    result = {
      kind: "error",
      message:
        err instanceof CoreApiError
          ? (REFUSED[err.code] ?? `Identity refused: ${err.message}`)
          : "Something went wrong. Nothing was changed.",
    };
  }
  redirect(withMessage(back, result.kind, result.message));
}

export async function suspendPerson(formData: FormData) {
  await accountAction(formData, "suspend");
}

export async function reactivatePerson(formData: FormData) {
  await accountAction(formData, "reactivate");
}
