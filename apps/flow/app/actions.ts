"use server";

import { ACCESS_COOKIE_NAME } from "@asafarim/app-sdk";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { z } from "zod";
import { buildCatalog } from "@/lib/builder/catalog";
import { builderProblems, checkDataOf, dataProblems } from "@/lib/builder/checks";
import { WORKFLOW_FILE_MAX_BYTES } from "@/lib/builder/file";
import { parseWorkflowFile } from "@/lib/builder/file-import";
import { draftOf } from "@/lib/builder/open";
import { newTrigger, starterDraft } from "@/lib/builder/ops";
import { creationFrom, rotationFrom, type CredentialFormState } from "@/lib/credentials/form";
import { createCredential, deleteCredential, rotateCredential } from "@/lib/credentials/store";
import { db, engine, inTransaction } from "@/lib/db";
import { DRAFT_MAX_BYTES } from "@/lib/engine/engine";
import { APPROVAL_ID, CREDENTIAL_ID, RUN_ID } from "@/lib/format";
import { gate, type GateResult } from "@/lib/gate";
import type { HookFormState } from "@/lib/hooks/example";
import { createHook, deleteHook, regenerateHookSecret } from "@/lib/hooks/store";
import { getBuilderWorkflow } from "@/lib/queries";
import { HOOK_ID } from "@/lib/workflow/definition-v2";
import { parseEgressHosts, parseEmailRecipients, setList, setPausedAll } from "@/lib/settings";
import type { Problem } from "@/lib/workflow/definition";
import { manualInputOf } from "@/lib/workflow/manual";
import { workflowKey } from "@/lib/workflow/schema";

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
 * The builder's server functions (components/builder), gated by flow.workflows.write, their input
 * checked with Zod after the gate, and audited (ids only). Each answers with the result rather than a
 * redirect. The problems they answer with are every check the builder shows (lib/builder/checks.ts):
 * the definition's own and those of Flow's data (credentials, allow-lists).
 */
export interface DraftResult {
  ok: boolean;
  /** A refusal: the gate's (`forbidden`, …), the input's (`invalid_input`) or the engine's (`stale_draft`, …). */
  error?: string;
  permission?: string;
  /** What is wrong with the definition, by node. */
  problems?: Problem[];
  /** saveDraft: when the draft saved now was saved (the next save names it), ISO 8601. */
  draftUpdatedAt?: string;
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

/** A draft as the builder sends it: any JSON object (it may not validate yet), at most DRAFT_MAX_BYTES. */
const Definition = z
  .record(z.string(), z.unknown())
  .refine((d) => JSON.stringify(d).length <= DRAFT_MAX_BYTES, "too large");
const SaveInput = z.object({ workflowKey, definition: Definition, lastSeen: z.iso.datetime().nullable() });
const KeyInput = z.object({ workflowKey });
const ValidateInput = z.object({ workflowKey, definition: Definition });
const TestInput = z.object({ workflowKey, data: z.record(z.string(), z.unknown()), dryRun: z.boolean() });
const ImportWorkflowInput = z.object({
  name: z.string().trim().min(1).max(200),
  key: workflowKey,
  file: z.string().max(WORKFLOW_FILE_MAX_BYTES),
});

export type WorkflowImportResult =
  | { ok: true; workflowKey: string }
  | { ok: false; error: string; problems?: string[] };

/** Import an untrusted workflow export as a new draft; it is never published. */
export async function importWorkflowFileAction(
  name: unknown,
  key: unknown,
  file: unknown,
): Promise<WorkflowImportResult> {
  const g = await gate("flow.workflows.write");
  if (!g.ok)
    return {
      ok: false,
      error: g.body.error,
      ...(g.body.permission ? { permission: g.body.permission } : {}),
    };
  const input = ImportWorkflowInput.safeParse({ name, key, file });
  if (!input.success || new TextEncoder().encode(input.data?.file ?? "").byteLength > WORKFLOW_FILE_MAX_BYTES)
    return { ok: false, error: "The workflow name, key, or file is invalid. The file limit is 256 KiB." };

  let value: unknown;
  try {
    value = JSON.parse(input.data.file);
  } catch {
    return { ok: false, error: "The selected file isn't valid JSON." };
  }
  const parsed = parseWorkflowFile(value);
  if (!parsed.ok) return { ok: false, error: parsed.error, ...(parsed.problems ? { problems: parsed.problems } : {}) };

  const definition = { ...parsed.definition, key: input.data.key };
  const result = await inTransaction(await db(), async (tx) => {
    const saved = await engine.saveDraft(tx, {
      workflowKey: input.data.key,
      name: input.data.name,
      definition,
      actor: g.subject,
      expect: "new",
    });
    if (!saved.ok) return saved;
    return { ...saved, problems: builderProblems(definition, saved.problems, await checkDataOf(tx)) };
  });
  if (!result.ok)
    return { ok: false, error: result.error === "exists" ? "A workflow already uses that key." : `The workflow could not be imported (${result.error}).` };
  return { ok: true, workflowKey: input.data.key };
}

/**
 * Save a workflow's draft (it must exist: New and Duplicate make one). `lastSeen`: when the draft the
 * editor started from was saved (null: none); someone else's save since then refuses it (`stale_draft`).
 */
export async function saveDraft(workflowKey: unknown, definition: unknown, lastSeen: unknown): Promise<DraftResult> {
  return asWriter(async (actor) => {
    const input = SaveInput.safeParse({ workflowKey, definition, lastSeen });
    if (!input.success) return { ok: false, error: "invalid_input" };
    const { workflowKey: key, lastSeen: seen } = input.data;
    return inTransaction(await db(), async (tx) => {
      const r = await engine.saveDraft(tx, {
        workflowKey: key,
        definition,
        actor,
        expect: { draftUpdatedAt: seen === null ? null : new Date(seen) },
      });
      if (!r.ok) return r;
      const problems = builderProblems(definition, r.problems, await checkDataOf(tx));
      return { ok: true, problems, draftUpdatedAt: r.draftUpdatedAt.toISOString(), audits: r.audits };
    }).then(strip);
  });
}

/** Every problem of `definition` (the draft as the editor has it), without saving it. */
export async function validateDraft(workflowKey: unknown, definition: unknown): Promise<DraftResult> {
  return asWriter(async () => {
    const input = ValidateInput.safeParse({ workflowKey, definition });
    if (!input.success) return { ok: false, error: "invalid_input" };
    const data = await checkDataOf(await db());
    return { ok: true, problems: builderProblems(definition, engine.checkDefinition(definition), data) };
  });
}

/** Publish a workflow's draft as its next version: refused (`invalid_definition`) while it has any problem. */
export async function publishDraft(workflowKey: unknown): Promise<DraftResult> {
  return asWriter(async (actor) => {
    const input = KeyInput.safeParse({ workflowKey });
    if (!input.success) return { ok: false, error: "invalid_input" };
    return strip(
      await inTransaction(await db(), async (tx) => {
        const data = await checkDataOf(tx);
        return engine.publishDraft(tx, {
          workflowKey: input.data.workflowKey,
          actor,
          check: async (draft) => dataProblems(draft, data),
        });
      }),
    );
  });
}

/** A test run of a workflow's draft (a dry run with `dryRun`), `data` as its trigger's data. */
export async function testDraft(workflowKey: unknown, data: unknown, dryRun: unknown): Promise<DraftResult> {
  return asWriter(async (actor) => {
    const input = TestInput.safeParse({ workflowKey, data, dryRun });
    if (!input.success) return { ok: false, error: "invalid_input" };
    const { workflowKey: key, data: trigger, dryRun: dry } = input.data;
    return strip(
      await inTransaction(await db(), (tx) =>
        engine.startDraftRun(tx, { workflowKey: key, data: trigger, dryRun: dry, actor }),
      ),
    );
  });
}

const NewWorkflow = z.object({
  name: z.string().trim().min(1).max(200),
  key: workflowKey,
  trigger: z.string().max(40),
});

/** New workflow (flow.workflows.write): its first draft (the trigger, then an end), then the builder. */
export async function createWorkflowAction(formData: FormData) {
  const g = await gate("flow.workflows.write");
  if (!g.ok) redirect(refused("/workflows/new", g));
  const input = NewWorkflow.safeParse({
    name: formData.get("name"),
    key: formData.get("key"),
    trigger: formData.get("trigger"),
  });
  const spec = input.success ? buildCatalog().triggers.find((t) => t.type === input.data.trigger) : undefined;
  if (!input.success || !spec) redirect("/workflows/new?error=invalid_workflow");
  const { key, name } = input.data;
  const r = await inTransaction(await db(), (tx) =>
    engine.saveDraft(tx, {
      workflowKey: key,
      name,
      definition: starterDraft(key, newTrigger(spec)),
      actor: g.subject,
      expect: "new",
    }),
  );
  redirect(r.ok ? `/workflows/${key}/edit` : `/workflows/new?error=${r.error}`);
}

const Duplicate = z.object({ workflow: workflowKey, key: workflowKey, name: z.string().trim().min(1).max(200) });

/**
 * Duplicate (flow.workflows.write): a new workflow whose draft is the source's (its draft, else its
 * published version), under the new key; audited with both workflows' ids. Then the builder.
 */
export async function duplicateWorkflowAction(formData: FormData) {
  const g = await gate("flow.workflows.write");
  if (!g.ok) redirect(refused("/workflows", g));
  const input = Duplicate.safeParse({
    workflow: formData.get("workflow"),
    key: formData.get("key"),
    name: formData.get("name"),
  });
  if (!input.success) redirect("/workflows?error=invalid_workflow");
  const { workflow, key, name } = input.data;
  const pool = await db();
  const source = await getBuilderWorkflow(pool, workflow);
  if (!source) redirect("/workflows?error=not_found");
  const from = draftOf(source);
  // A hook belongs to one workflow: the copy's trigger needs one of its own.
  const trigger = "hook" in from.trigger ? { ...from.trigger, hook: "" } : from.trigger;
  const r = await inTransaction(pool, async (tx) => {
    const saved = await engine.saveDraft(tx, {
      workflowKey: key,
      name,
      definition: { ...from, key, trigger },
      actor: g.subject,
      expect: "new",
    });
    if (!saved.ok) return saved;
    return {
      ...saved,
      audits: [
        ...saved.audits,
        {
          action: "flow.workflow.duplicated" as const,
          workflow: key,
          workflowId: saved.workflowId,
          source: source.key,
          sourceId: source.id,
          actor: g.subject,
        },
      ],
    };
  });
  redirect(r.ok ? `/workflows/${key}/edit` : `/workflows?error=${r.error}`);
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
  redirect(`/settings?saved=${key}`);
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
  redirect(`/settings?saved=${on ? "paused" : "resumed"}`);
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
  // The Workflows page and the builder (whose trigger settings pick the hook) show it.
  revalidatePath("/workflows", "layout");
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
  // Back to the Workflows page, or to the builder it was deleted from.
  const raw = String(formData.get("back") ?? "");
  const back = /^\/workflows\/[a-z][a-z0-9-]{0,63}\/edit$/.test(raw) ? raw : "/workflows";
  if (!HOOK_ID.test(id)) redirect(back);
  const g = await gate("flow.workflows.write");
  if (!g.ok) redirect(refused(back, g));
  const r = await inTransaction(await db(), (tx) => deleteHook(tx, id, g.subject));
  redirect(r.ok ? back : `${back}?error=${r.error}`);
}
