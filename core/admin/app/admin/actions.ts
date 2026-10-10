"use server";

/**
 * Every admin action, as the signed-in administrator: each one re-checks that the person is
 * still an administrator, then calls core-api's admin API with their identity token. core-api
 * does the real authorisation (core.admin, live) and writes the audit event under their name.
 */
import { redirect } from "next/navigation";
import { CoreApiError, coreApi } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { confirmsRemoval, isAppId, isRoleKey, isSubject, safeAdminPath, withMessage } from "@/lib/util";

/** Run `work`, then go back to `next` with the outcome. redirect() throws, so it stays outside the try. */
async function perform(formData: FormData, work: (api: ReturnType<typeof coreApi>) => Promise<string>) {
  const admin = await requireAdmin();
  const next = safeAdminPath(formData.get("next"));
  let result: { kind: "notice" | "error"; message: string };
  try {
    result = { kind: "notice", message: await work(coreApi(admin.idToken)) };
  } catch (err) {
    result =
      err instanceof CoreApiError
        ? { kind: "error", message: `core-api refused: ${err.message}` }
        : { kind: "error", message: "Something went wrong. Nothing was changed." };
  }
  redirect(withMessage(next, result.kind, result.message));
}

export async function activateApp(formData: FormData) {
  const app = formData.get("app");
  await perform(formData, async (api) => {
    if (!isAppId(app)) throw new CoreApiError(400, "bad_request", "That isn't an app id.");
    await api.activate(app);
    return `${app} is active: it is served at its address and appears in launchers.`;
  });
}

export async function deactivateApp(formData: FormData) {
  const app = formData.get("app");
  await perform(formData, async (api) => {
    if (!isAppId(app)) throw new CoreApiError(400, "bad_request", "That isn't an app id.");
    await api.deactivate(app);
    return `${app} is inactive: its address shows the unavailable page and it's gone from launchers. Its data is kept.`;
  });
}

export async function removeApp(formData: FormData) {
  const app = formData.get("app");
  await perform(formData, async (api) => {
    if (!isAppId(app)) throw new CoreApiError(400, "bad_request", "That isn't an app id.");
    if (!confirmsRemoval(app, formData.get("confirm")))
      throw new CoreApiError(400, "bad_request", `Type ${app} to confirm the removal. Nothing was changed.`);
    const out = await api.remove(app);
    const grants = out.removedGrants.length;
    const waiting = new Set(out.warnings.map((w) => w.app)).size;
    return (
      `${app} is removed: its credentials are revoked and ${grants} grant${grants === 1 ? "" : "s"} deleted.` +
      (waiting ? ` ${waiting} app${waiting === 1 ? "" : "s"} now wait for a publisher of its events.` : "") +
      " Install it again with the CLI to bring it back."
    );
  });
}

export async function grantRole(formData: FormData) {
  const role = formData.get("role");
  const subject = formData.get("subject");
  await perform(formData, async (api) => {
    if (!isRoleKey(role) || !isSubject(subject))
      throw new CoreApiError(400, "bad_request", "Pick a role and a person.");
    const { granted } = await api.grant(role, subject);
    return granted ? `Granted ${role} to ${subject}.` : `${subject} already holds ${role}.`;
  });
}

export async function revokeRole(formData: FormData) {
  const role = formData.get("role");
  const subject = formData.get("subject");
  await perform(formData, async (api) => {
    if (!isRoleKey(role) || !isSubject(subject))
      throw new CoreApiError(400, "bad_request", "Pick a role and a person.");
    const { revoked } = await api.revoke(role, subject);
    return revoked ? `Revoked ${role} from ${subject}.` : `${subject} didn't hold ${role}.`;
  });
}
