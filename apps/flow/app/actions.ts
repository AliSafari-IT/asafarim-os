"use server";

import { ACCESS_COOKIE_NAME } from "@asafarim/app-sdk";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { creationFrom, rotationFrom, type CredentialFormState } from "@/lib/credentials/form";
import { createCredential, deleteCredential, rotateCredential } from "@/lib/credentials/store";
import { db, engine, inTransaction } from "@/lib/db";
import { APPROVAL_ID, CREDENTIAL_ID, RUN_ID } from "@/lib/format";
import { gate, type GateResult } from "@/lib/gate";
import type { HookFormState } from "@/lib/hooks/example";
import { createHook, deleteHook, regenerateHookSecret } from "@/lib/hooks/store";
import { HOOK_ID } from "@/lib/workflow/definition-v2";
import { parseEgressHosts, parseEmailRecipients, setList, setPausedAll } from "@/lib/settings";
import type { Problem } from "@/lib/workflow/definition";
import { manualInputOf } from "@/lib/workflow/manual";

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

/**
 * "Run now" for a workflow whose current version has a manual trigger (flow.runs.start): the form's
 * fields as its input (lib/workflow/manual.ts), then the run's page, or back with the refusal.
 */
export async function runNowAction(formData: FormData) {
  const key = String(formData.get("workflow") ?? "");
  const g = await gate("flow.runs.start");
  if (!g.ok) redirect(`/workflows?error=${g.body.error}${g.body.permission ? `&permission=${g.body.permission}` : ""}`);
  const r = await inTransaction(await db(), (tx) =>
    engine.startRun(tx, {
      workflowKey: key,
      trigger: "manual",
      data: manualInputOf(formData),
      actor: g.subject,
    }),
  );
  redirect(r.ok ? `/runs/${r.runId}` : `/workflows?error=${r.error}`);
}

/**
 * The builder's server functions (its UI comes with PR 2.6), gated by flow.workflows.write and
 * audited (ids only). Each answers with the result rather than a redirect.
 */
export interface DraftResult {
  ok: boolean;
  /** A refusal: the gate's (`forbidden`, …) or the engine's (`invalid_definition`, …). */
  error?: string;
  permission?: string;
  /** What is wrong with the definition, by node. */
  problems?: Problem[];
  /** publishDraft: the version published. */
  version?: number;
  /** testDraft: the run started. */
  runId?: string;
}

async function asWriter(fn: (subject: string) => Promise<DraftResult>): Promise<DraftResult> {
  const g = await gate("flow.workflows.write");
  if (!g.ok) return { ok: false, error: g.body.error, ...(g.body.permission ? { permission: g.body.permission } : {}) };
  return fn(g.subject);
}
const strip = <T extends { audits: unknown }>({ audits: _audits, ...rest }: T) => rest;

/** Save a workflow's draft (a new workflow when the key is new): the problems found in it, by node. */
export async function saveDraft(workflowKey: string, definition: unknown, name?: string): Promise<DraftResult> {
  return asWriter(async (actor) =>
    strip(await inTransaction(await db(), (tx) => engine.saveDraft(tx, { workflowKey, name, definition, actor }))),
  );
}

/** Publish a workflow's draft as its next version. */
export async function publishDraft(workflowKey: string): Promise<DraftResult> {
  return asWriter(async (actor) =>
    strip(await inTransaction(await db(), (tx) => engine.publishDraft(tx, { workflowKey, actor }))),
  );
}

/** A test run of a workflow's draft (a dry run with `dryRun`), `data` as its trigger's data. */
export async function testDraft(workflowKey: string, data: unknown, dryRun: boolean): Promise<DraftResult> {
  return asWriter(async (actor) =>
    strip(await inTransaction(await db(), (tx) => engine.startDraftRun(tx, { workflowKey, data, dryRun, actor }))),
  );
}

/** The labels as typed: comma- or line-separated, trimmed, empty ones dropped, each once. */
const labelsOf = (raw: string) => [
  ...new Set(
    raw
      .split(/[,\n]/)
      .map((l) => l.trim())
      .filter(Boolean),
  ),
];
/** A textarea posts CRLF line ends; the draft has LF. */
const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : undefined);

/** Approve or reject an approval (flow.approvals.decide); back to the approval, with the refusal if there was one. */
async function onDecision(formData: FormData, what: "approve" | "reject") {
  const id = String(formData.get("approvalId") ?? "");
  if (!APPROVAL_ID.test(id)) redirect("/approvals");
  const g = await gate("flow.approvals.decide");
  if (!g.ok)
    redirect(`/approvals/${id}?error=${g.body.error}${g.body.permission ? `&permission=${g.body.permission}` : ""}`);
  let edits: Record<string, unknown> = {};
  if (what === "approve") {
    // Only the fields the form sent (the editable ones); the engine refuses any other.
    const title = text(formData.get("title"));
    const body = text(formData.get("body"));
    const labels = text(formData.get("labels"));
    edits = {
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(labels !== undefined ? { labels: labelsOf(labels) } : {}),
    };
  }
  const r = await inTransaction(await db(), (tx) =>
    what === "approve"
      ? engine.approve(tx, id, g.subject, edits, formData.get("acknowledgedPublic") === "on")
      : engine.reject(tx, id, g.subject, text(formData.get("comment")) ?? null),
  );
  redirect(r.ok ? `/approvals/${id}` : `/approvals/${id}?error=${r.error}`);
}

export async function approveAction(formData: FormData) {
  await onDecision(formData, "approve");
}

export async function rejectAction(formData: FormData) {
  await onDecision(formData, "reject");
}

/** Where a refused action goes back to: `path` with the refusal (and the permission it lacked). */
const refused = (path: string, g: Extract<GateResult, { ok: false }>) =>
  `${path}?error=${g.body.error}${g.body.permission ? `&permission=${g.body.permission}` : ""}`;

/**
 * Add or rotate a credential (flow.credentials.write). The answer goes back to the form, not through a
 * redirect: a generated webhook secret is in it, shown once, and must not land in a URL.
 */
async function onCredential(formData: FormData, what: "create" | "rotate"): Promise<CredentialFormState> {
  const id = String(formData.get("credentialId") ?? "");
  if (what === "rotate" && !CREDENTIAL_ID.test(id)) return { status: "error", error: "not_found" };
  const g = await gate("flow.credentials.write");
  if (!g.ok)
    return { status: "error", error: g.body.error, ...(g.body.permission ? { permission: g.body.permission } : {}) };
  const r = await inTransaction(await db(), (tx) =>
    what === "create"
      ? createCredential(tx, creationFrom(formData), g.subject)
      : rotateCredential(tx, id, rotationFrom(formData), g.subject),
  );
  if (!r.ok) return { status: "error", error: r.error };
  revalidatePath("/credentials");
  return { status: "done", kind: r.kind, ...(r.shownOnce ? { secret: r.shownOnce } : {}) };
}

export async function createCredentialAction(_prev: CredentialFormState, formData: FormData) {
  return onCredential(formData, "create");
}

export async function rotateCredentialAction(_prev: CredentialFormState, formData: FormData) {
  return onCredential(formData, "rotate");
}

/** Delete a credential (flow.credentials.write). */
export async function deleteCredentialAction(formData: FormData) {
  const id = String(formData.get("credentialId") ?? "");
  if (!CREDENTIAL_ID.test(id)) redirect("/credentials");
  const g = await gate("flow.credentials.write");
  if (!g.ok) redirect(refused("/credentials", g));
  const r = await inTransaction(await db(), (tx) => deleteCredential(tx, id, g.subject));
  redirect(r.ok ? "/credentials" : `/credentials?error=${r.error}`);
}

/** Replace one allow-list (flow.settings.write). */
async function onList(formData: FormData, key: "egress_hosts" | "email_recipients") {
  const g = await gate("flow.settings.write");
  if (!g.ok) redirect(refused("/settings", g));
  const raw = String(formData.get("entries") ?? "");
  const parsed = key === "egress_hosts" ? parseEgressHosts(raw) : parseEmailRecipients(raw);
  if (!parsed.ok) redirect(`/settings?error=${parsed.error}&list=${key}`);
  await inTransaction(await db(), (tx) => setList(tx, key, parsed.entries, g.subject));
  redirect("/settings");
}

export async function saveEgressHostsAction(formData: FormData) {
  await onList(formData, "egress_hosts");
}

export async function saveEmailRecipientsAction(formData: FormData) {
  await onList(formData, "email_recipients");
}

/** Pause all or Resume all (flow.settings.write): the kill switch. */
export async function setPausedAllAction(formData: FormData) {
  const on = formData.get("pausedAll") === "on";
  const g = await gate("flow.settings.write");
  if (!g.ok) redirect(refused("/settings", g));
  await inTransaction(await db(), (tx) => setPausedAll(tx, on, g.subject));
  redirect("/settings");
}

/**
 * A workflow's hook (flow.workflows.write): create one, or a new secret for it. The answer goes back to
 * the form, not through a redirect: the secret is in it, shown once, and must not land in a URL.
 */
async function onHook(formData: FormData, what: "create" | "regenerate"): Promise<HookFormState> {
  const id = String(formData.get("hookId") ?? "");
  if (what === "regenerate" && !HOOK_ID.test(id)) return { status: "error", error: "not_found" };
  const g = await gate("flow.workflows.write");
  if (!g.ok)
    return { status: "error", error: g.body.error, ...(g.body.permission ? { permission: g.body.permission } : {}) };
  const r = await inTransaction(await db(), (tx) =>
    what === "create"
      ? createHook(
          tx,
          { workflowKey: String(formData.get("workflow") ?? ""), kind: String(formData.get("kind") ?? "") },
          g.subject,
        )
      : regenerateHookSecret(tx, id, g.subject),
  );
  if (!r.ok) return { status: "error", error: r.error };
  revalidatePath("/workflows");
  return { status: "done", hookId: r.id, kind: r.kind, ...(r.shownOnce ? { secret: r.shownOnce } : {}) };
}

export async function createHookAction(_prev: HookFormState, formData: FormData) {
  return onHook(formData, "create");
}

export async function regenerateHookAction(_prev: HookFormState, formData: FormData) {
  return onHook(formData, "regenerate");
}

/** Delete a workflow's hook and its secret (flow.workflows.write): its URL answers 404 from then on. */
export async function deleteHookAction(formData: FormData) {
  const id = String(formData.get("hookId") ?? "");
  if (!HOOK_ID.test(id)) redirect("/workflows");
  const g = await gate("flow.workflows.write");
  if (!g.ok) redirect(refused("/workflows", g));
  const r = await inTransaction(await db(), (tx) => deleteHook(tx, id, g.subject));
  redirect(r.ok ? "/workflows" : `/workflows?error=${r.error}`);
}
