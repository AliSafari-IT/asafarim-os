/**
 * The credential store (the `credentials` table). A secret goes in and is never read back except by a
 * connector, through useCredential: listCredentials doesn't select the ciphertext, no function returns
 * a secret to a page, and errors and audit entries carry ids and kinds only. The one exception is the
 * webhook secret Flow generates: createCredential and rotateCredential return it once, for the person
 * who made it to copy.
 *
 * Kinds, and what is secret (encrypted) and what isn't (`meta`, shown on the page):
 *
 *   smtp            secret: username, password        meta: host, port, mode (starttls, tls; none for
 *                                                     loopback only), from
 *   github-token    secret: token                     meta: repos (the ones it may act on)
 *   gitlab-token    secret: token                     meta: projects (gitlab.com paths it may read; issue
 *                                                     drafting, lib/generate)
 *   webhook-secret  secret: 32 random bytes (base64url), generated here
 */
import { randomBytes } from "node:crypto";
import { ulid } from "@asafarim/app-sdk/events";
import { z } from "zod";
import type { AuditEntry } from "../audit";
import { isHostName, SMTP_PORTS } from "../egress/hosts";
import { rowsOf, type Queryable } from "../settings";
import { AAD_VERSION, CredentialError, keyringFromEnv, open, seal, type Binding, type Keyring } from "./cipher";

export { CredentialError };

export const KINDS = ["smtp", "github-token", "gitlab-token", "webhook-secret"] as const;
export type CredentialKind = (typeof KINDS)[number];

const Name = z.string().trim().min(1).max(100);
const Host = z
  .string()
  .trim()
  .toLowerCase()
  .refine((h) => isHostName(h));
const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const Repo = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
/** A gitlab.com project path: group[/subgroup…]/project. */
const Project = z
  .string()
  .max(255)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/){1,20}[A-Za-z0-9_][A-Za-z0-9_.-]*$/);

const SmtpSecret = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) });
const GithubSecret = z.object({ token: z.string().regex(/^\S{1,255}$/) });
const WebhookSecret = z.object({ secret: z.string().min(1) });

/** `none` (no TLS): local development only, a loopback server (the connector also refuses it in production). */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
const SmtpMeta = z
  .object({
    host: z.string().trim().toLowerCase().max(253),
    port: z.coerce.number().int().min(1).max(65535),
    mode: z.enum(["starttls", "tls", "none"]),
    from: Email,
  })
  .refine((m) => (m.mode === "none" ? LOOPBACK_HOSTS.includes(m.host) : Host.safeParse(m.host).success), {
    path: ["host"],
  })
  // With TLS the port is 465 or 587, as the host is a name, not an address; `none` is a loopback server.
  .refine((m) => m.mode === "none" || SMTP_PORTS.includes(m.port), { path: ["port"] });
const GithubMeta = z.object({ repos: z.array(Repo).min(1).max(50) });
const GitlabMeta = z.object({ projects: z.array(Project).min(1).max(50) });

export const CredentialInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("smtp"), name: Name, meta: SmtpMeta, secret: SmtpSecret }),
  z.object({ kind: z.literal("github-token"), name: Name, meta: GithubMeta, secret: GithubSecret }),
  z.object({ kind: z.literal("gitlab-token"), name: Name, meta: GitlabMeta, secret: GithubSecret }),
  z.object({ kind: z.literal("webhook-secret"), name: Name }),
]);
export type CredentialInput = z.input<typeof CredentialInput>;

/** What a rotation takes: the new secret (smtp, github-token, gitlab-token); a webhook secret is generated. */
export const RotationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("smtp"), secret: SmtpSecret }),
  z.object({ kind: z.literal("github-token"), secret: GithubSecret }),
  z.object({ kind: z.literal("gitlab-token"), secret: GithubSecret }),
  z.object({ kind: z.literal("webhook-secret") }),
]);
export type RotationInput = z.input<typeof RotationInput>;

/** What useCredential returns per kind: the secret with the meta a connector needs next to it. */
export interface CredentialOf {
  smtp: z.infer<typeof SmtpMeta> & z.infer<typeof SmtpSecret>;
  "github-token": z.infer<typeof GithubMeta> & z.infer<typeof GithubSecret>;
  "gitlab-token": z.infer<typeof GitlabMeta> & z.infer<typeof GithubSecret>;
  "webhook-secret": z.infer<typeof WebhookSecret>;
}

const SECRET_SCHEMA = {
  smtp: SmtpSecret,
  "github-token": GithubSecret,
  "gitlab-token": GithubSecret,
  "webhook-secret": WebhookSecret,
} as const;

export interface CredentialSummary {
  id: string;
  name: string;
  kind: CredentialKind;
  meta: Record<string, unknown>;
  createdAt: Date;
  createdBy: string;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
}

export type Refusal =
  "invalid_credential" | "credential_name_taken" | "credential_not_found" | "credentials_unavailable";
export type WriteResult =
  | { ok: true; id: string; kind: CredentialKind; shownOnce?: string; audits: AuditEntry[] }
  | { ok: false; error: Refusal; audits: AuditEntry[] };

/** The keyring, or undefined when FLOW_CREDENTIALS_KEY is missing or invalid. */
export function credentialKeys(env: Record<string, string | undefined> = process.env): Keyring | undefined {
  const state = keyringFromEnv(env);
  return state.ok ? state.keyring : undefined;
}

/** Whether this server can store and use credentials. */
export const credentialsAvailable = (env: Record<string, string | undefined> = process.env) =>
  credentialKeys(env) !== undefined;

const newWebhookSecret = () => randomBytes(32).toString("base64url");

export async function listCredentials(q: Queryable): Promise<CredentialSummary[]> {
  const rows = await rowsOf(
    q,
    `SELECT id, name, kind, meta, created_at, created_by, rotated_at, last_used_at
       FROM credentials ORDER BY lower(name)`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as CredentialKind,
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdAt: r.created_at as Date,
    createdBy: r.created_by as string,
    rotatedAt: (r.rotated_at as Date | null) ?? null,
    lastUsedAt: (r.last_used_at as Date | null) ?? null,
  }));
}

export async function createCredential(
  q: Queryable,
  input: unknown,
  actor: string,
  keyring = credentialKeys(),
): Promise<WriteResult> {
  if (!keyring) return { ok: false, error: "credentials_unavailable", audits: [] };
  const parsed = CredentialInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_credential", audits: [] };
  const c = parsed.data;
  const id = ulid();
  const shownOnce = c.kind === "webhook-secret" ? newWebhookSecret() : undefined;
  const secret = c.kind === "webhook-secret" ? { secret: shownOnce } : c.secret;
  const meta = c.kind === "webhook-secret" ? {} : c.meta;
  const sealed = seal(keyring, { id, kind: c.kind, meta }, JSON.stringify(secret));
  const rows = await rowsOf(
    q,
    `INSERT INTO credentials (id, name, kind, ciphertext, iv, key_version, aad_version, meta, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (name) DO NOTHING RETURNING id`,
    [
      id,
      c.name,
      c.kind,
      sealed.ciphertext,
      sealed.iv,
      sealed.keyVersion,
      sealed.aadVersion,
      JSON.stringify(meta),
      actor,
    ],
  );
  if (!rows.length) return { ok: false, error: "credential_name_taken", audits: [] };
  return {
    ok: true,
    id,
    kind: c.kind,
    ...(shownOnce ? { shownOnce } : {}),
    audits: [{ action: "flow.credential.created", credentialId: id, kind: c.kind, actor }],
  };
}

/** A new secret for an existing credential (same id, name, kind and meta). */
export async function rotateCredential(
  q: Queryable,
  id: string,
  input: unknown,
  actor: string,
  keyring = credentialKeys(),
): Promise<WriteResult> {
  if (!keyring) return { ok: false, error: "credentials_unavailable", audits: [] };
  const parsed = RotationInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_credential", audits: [] };
  const rows = await rowsOf(q, "SELECT kind, meta FROM credentials WHERE id = $1 FOR UPDATE", [id]);
  const kind = rows[0]?.kind as CredentialKind | undefined;
  if (!kind) return { ok: false, error: "credential_not_found", audits: [] };
  if (kind !== parsed.data.kind) return { ok: false, error: "invalid_credential", audits: [] };
  const r = parsed.data;
  const shownOnce = r.kind === "webhook-secret" ? newWebhookSecret() : undefined;
  const secret = r.kind === "webhook-secret" ? { secret: shownOnce } : r.secret;
  // Sealed under the settings the row has now: a rotation is also what binds an older row to them.
  const sealed = seal(keyring, { id, kind, meta: rows[0]!.meta }, JSON.stringify(secret));
  await q.query(
    "UPDATE credentials SET ciphertext = $2, iv = $3, key_version = $4, aad_version = $5, rotated_at = now() WHERE id = $1",
    [id, sealed.ciphertext, sealed.iv, sealed.keyVersion, sealed.aadVersion],
  );
  return {
    ok: true,
    id,
    kind,
    ...(shownOnce ? { shownOnce } : {}),
    audits: [{ action: "flow.credential.rotated", credentialId: id, kind, actor }],
  };
}

export async function deleteCredential(q: Queryable, id: string, actor: string): Promise<WriteResult> {
  const rows = await rowsOf(q, "DELETE FROM credentials WHERE id = $1 RETURNING kind", [id]);
  const kind = rows[0]?.kind as CredentialKind | undefined;
  if (!kind) return { ok: false, error: "credential_not_found", audits: [] };
  return { ok: true, id, kind, audits: [{ action: "flow.credential.deleted", credentialId: id, kind, actor }] };
}

/**
 * For connectors: the credential `id`, decrypted, which must be of `kind`; its last_used_at is set.
 * A CredentialError (credentials_unavailable, credential_not_found, credential_kind_mismatch,
 * credential_unreadable) otherwise.
 */
export async function useCredential<K extends CredentialKind>(
  tx: Queryable,
  id: string,
  kind: K,
  keyring = credentialKeys(),
): Promise<CredentialOf[K]> {
  if (!keyring) throw new CredentialError("credentials_unavailable");
  const rows = await rowsOf(
    tx,
    "SELECT kind, ciphertext, iv, key_version, aad_version, meta FROM credentials WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new CredentialError("credential_not_found");
  if (row.kind !== kind) throw new CredentialError("credential_kind_mismatch");
  // The settings are part of what the ciphertext was sealed with: a host or a port changed in the table
  // makes the row unreadable instead of sending the secret somewhere else.
  const binding: Binding = { id, kind, meta: row.meta };
  const plaintext = open(keyring, binding, {
    ciphertext: row.ciphertext as Buffer,
    iv: row.iv as Buffer,
    keyVersion: row.key_version as number,
    aadVersion: row.aad_version as number,
  });
  // A row made before the settings were bound is bound now, as the secret has just been read with them.
  if ((row.aad_version as number) < AAD_VERSION) {
    const upgraded = seal(keyring, binding, plaintext);
    await tx.query(
      "UPDATE credentials SET ciphertext = $2, iv = $3, key_version = $4, aad_version = $5 WHERE id = $1 AND aad_version < $5",
      [id, upgraded.ciphertext, upgraded.iv, upgraded.keyVersion, upgraded.aadVersion],
    );
  }
  let secret: unknown;
  try {
    secret = SECRET_SCHEMA[kind].parse(JSON.parse(plaintext));
  } catch {
    throw new CredentialError("credential_unreadable");
  }
  await tx.query("UPDATE credentials SET last_used_at = now() WHERE id = $1", [id]);
  return { ...(row.meta as object), ...(secret as object) } as CredentialOf[K];
}
