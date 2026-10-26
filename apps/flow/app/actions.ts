"use server";

import { ACCESS_COOKIE_NAME } from "@asafarim/app-sdk";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { db, engine, inTransaction } from "@/lib/db";
import { RUN_ID } from "@/lib/format";
import { gate } from "@/lib/gate";

export async function signInAction() {
  await signIn("asafarim", { redirectTo: "/" });
}

export async function signOutAction() {
  // Drop the gateway's access token with the session. A __Host- cookie is only accepted (or removed)
  // with Secure, Path=/ and no Domain, so it's set expired with exactly those attributes.
  (await cookies()).set(ACCESS_COOKIE_NAME, "", {
    maxAge: 0,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
  await signOut({ redirectTo: "/" });
}

/** Retry or cancel a run (flow.runs.start); back to the Run page, with the refusal if there was one. */
async function onRun(formData: FormData, what: "retry" | "cancel") {
  const id = String(formData.get("runId") ?? "");
  if (!RUN_ID.test(id)) redirect("/runs");
  const g = await gate("flow.runs.start");
  if (!g.ok)
    redirect(`/runs/${id}?error=${g.body.error}${g.body.permission ? `&permission=${g.body.permission}` : ""}`);
  const r = await inTransaction(await db(), (tx) =>
    what === "retry" ? engine.retry(tx, id, g.subject) : engine.cancel(tx, id, g.subject),
  );
  redirect(r.ok ? `/runs/${id}` : `/runs/${id}?error=${r.error}`);
}

export async function retryRunAction(formData: FormData) {
  await onRun(formData, "retry");
}

export async function cancelRunAction(formData: FormData) {
  await onRun(formData, "cancel");
}

/** Pause or resume a workflow (flow.workflows.write). */
export async function setWorkflowStatusAction(formData: FormData) {
  const key = String(formData.get("workflow") ?? "");
  const status = formData.get("status") === "paused" ? "paused" : "active";
  const g = await gate("flow.workflows.write");
  if (!g.ok) redirect(`/workflows?error=${g.body.error}${g.body.permission ? `&permission=${g.body.permission}` : ""}`);
  const r = await inTransaction(await db(), (tx) => engine.setWorkflowStatus(tx, key, status, g.subject));
  redirect(r.ok ? "/workflows" : `/workflows?error=${r.error}`);
}
