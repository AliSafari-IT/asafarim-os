/**
 * Hooks (the `webhook_hooks` table): the one unauthenticated way into Flow, POST /hooks/<id>
 * (lib/hooks/receive.ts). A hook belongs to one workflow, is `generic` or `github`, and signs with a
 * `webhook-secret` credential the credential store generates; that secret is returned once, by the
 * create or the regeneration that made it. The id is 128 random bits, base64url: it is in the URL a
 * sender is given, so it is never the secret.
 *
 * Audit entries carry ids only: the hook's, the workflow key, the credential's.
 */
import { randomBytes } from "node:crypto";
import type { AuditEntry } from "../audit";
import { CredentialError, open, type Keyring } from "../credentials/cipher";
import { createCredential, credentialKeys, deleteCredential, rotateCredential } from "../credentials/store";
import { rowsOf, type Queryable } from "../settings";

export const HOOK_KINDS = ["generic", "github"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

export const newHookId = () => randomBytes(16).toString("base64url");

export interface HookSummary {
  id: string;
  workflowKey: string;
  kind: HookKind;
  createdAt: Date;
  lastCalledAt: Date | null;
}

/** A hook as the receiver needs it: its workflow and its secret, decrypted. */
export interface ReceivingHook {
  id: string;
  workflowKey: string;
  kind: HookKind;
  secret: string;
}

export type HookRefusal =
  "not_found" | "hook_exists" | "invalid_hook" | "credentials_unavailable" | "credential_name_taken";
export type HookResult =
  | { ok: true; id: string; kind: HookKind; workflowKey: string; shownOnce?: string; audits: AuditEntry[] }
  | { ok: false; error: HookRefusal; audits: AuditEntry[] };

const summaryOf = (r: Record<string, unknown>): HookSummary => ({
  id: r.id as string,
  workflowKey: r.workflow_key as string,
  kind: r.kind as HookKind,
  createdAt: r.created_at as Date,
  lastCalledAt: (r.last_called_at as Date | null) ?? null,
});

export async function listHooks(q: Queryable): Promise<HookSummary[]> {
  const rows = await rowsOf(
    q,
    `SELECT h.id, w.key AS workflow_key, h.kind, h.created_at, h.last_called_at
       FROM webhook_hooks h JOIN workflows w ON w.id = h.workflow_id ORDER BY w.key`,
  );
  return rows.map(summaryOf);
}

/** A new hook for `workflowKey` (one per workflow), its secret generated and returned once. */
export async function createHook(
  q: Queryable,
  input: { workflowKey: string; kind: string },
  actor: string,
  keyring = credentialKeys(),
): Promise<HookResult> {
  const refuse = (error: HookRefusal): HookResult => ({ ok: false, error, audits: [] });
  if (!HOOK_KINDS.includes(input.kind as HookKind)) return refuse("invalid_hook");
  const kind = input.kind as HookKind;
  const w = (await rowsOf(q, "SELECT id, key FROM workflows WHERE key = $1 FOR UPDATE", [input.workflowKey]))[0];
  if (!w) return refuse("not_found");
  if ((await rowsOf(q, "SELECT id FROM webhook_hooks WHERE workflow_id = $1", [w.id])).length)
    return refuse("hook_exists");
  const id = newHookId();
  const credential = await createCredential(
    q,
    { kind: "webhook-secret", name: `Hook ${id} (${String(w.key).slice(0, 64)})` },
    actor,
    keyring,
  );
  if (!credential.ok)
    return refuse(
      credential.error === "credentials_unavailable" || credential.error === "credential_name_taken"
        ? credential.error
        : "invalid_hook",
    );
  await q.query("INSERT INTO webhook_hooks (id, workflow_id, kind, credential_id) VALUES ($1, $2, $3, $4)", [
    id,
    w.id,
    kind,
    credential.id,
  ]);
  return {
    ok: true,
    id,
    kind,
    workflowKey: w.key as string,
    shownOnce: credential.shownOnce,
    audits: [
      ...credential.audits,
      { action: "flow.hook.created", hookId: id, workflow: w.key as string, credentialId: credential.id, kind, actor },
    ],
  };
}

async function hookRow(q: Queryable, id: string) {
  return (
    await rowsOf(
      q,
      `SELECT h.id, h.kind, h.credential_id, w.key AS workflow_key
         FROM webhook_hooks h JOIN workflows w ON w.id = h.workflow_id WHERE h.id = $1 FOR UPDATE OF h`,
      [id],
    )
  )[0];
}

/** A new secret for hook `id`, returned once; the old one stops working at once. */
export async function regenerateHookSecret(
  q: Queryable,
  id: string,
  actor: string,
  keyring = credentialKeys(),
): Promise<HookResult> {
  const h = await hookRow(q, id);
  if (!h) return { ok: false, error: "not_found", audits: [] };
  const r = await rotateCredential(q, h.credential_id as string, { kind: "webhook-secret" }, actor, keyring);
  if (!r.ok) return { ok: false, error: r.error === "credentials_unavailable" ? r.error : "not_found", audits: [] };
  return {
    ok: true,
    id,
    kind: h.kind as HookKind,
    workflowKey: h.workflow_key as string,
    shownOnce: r.shownOnce,
    audits: [
      ...r.audits,
      { action: "flow.hook.rotated", hookId: id, workflow: h.workflow_key as string, credentialId: r.id, actor },
    ],
  };
}

/** Delete hook `id` and its secret: its URL answers 404 from now on. */
export async function deleteHook(q: Queryable, id: string, actor: string): Promise<HookResult> {
  const h = await hookRow(q, id);
  if (!h) return { ok: false, error: "not_found", audits: [] };
  // The hook goes with its credential (ON DELETE CASCADE).
  const r = await deleteCredential(q, h.credential_id as string, actor);
  if (!r.ok) await q.query("DELETE FROM webhook_hooks WHERE id = $1", [id]);
  return {
    ok: true,
    id,
    kind: h.kind as HookKind,
    workflowKey: h.workflow_key as string,
    audits: [
      ...r.audits,
      {
        action: "flow.hook.deleted",
        hookId: id,
        workflow: h.workflow_key as string,
        credentialId: h.credential_id as string,
        actor,
      },
    ],
  };
}

/**
 * For the receiver: hook `id` with its secret, in ONE query whether the hook exists or not (an unknown
 * hook takes the time a known one does, up to the decryption). Undefined when there is no such hook.
 * A CredentialError when the secret can't be opened (no key on this server, the wrong one, or not a secret).
 */
export async function findHook(
  q: Queryable,
  id: string,
  keyring: Keyring | undefined = credentialKeys(),
): Promise<ReceivingHook | undefined> {
  const r = (
    await rowsOf(
      q,
      `SELECT h.id, h.kind, w.key AS workflow_key, c.id AS credential_id, c.ciphertext, c.iv, c.key_version
         FROM webhook_hooks h
         JOIN workflows w ON w.id = h.workflow_id
         JOIN credentials c ON c.id = h.credential_id AND c.kind = 'webhook-secret'
        WHERE h.id = $1`,
      [id],
    )
  )[0];
  if (!r) return undefined;
  if (!keyring) throw new CredentialError("credentials_unavailable");
  const plaintext = open(keyring, r.credential_id as string, {
    ciphertext: r.ciphertext as Buffer,
    iv: r.iv as Buffer,
    keyVersion: r.key_version as number,
  });
  let secret: unknown;
  try {
    secret = (JSON.parse(plaintext) as { secret?: unknown }).secret;
  } catch {
    secret = undefined;
  }
  // Never an empty key: anyone could sign with it.
  if (typeof secret !== "string" || !secret) throw new CredentialError("credential_unreadable");
  return { id, workflowKey: r.workflow_key as string, kind: r.kind as HookKind, secret };
}

/** The hook was called (signature checked): its last_called_at. */
export async function touchHook(q: Queryable, id: string): Promise<void> {
  await q.query("UPDATE webhook_hooks SET last_called_at = now() WHERE id = $1", [id]);
}
