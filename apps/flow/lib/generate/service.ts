/**
 * What surrounds a generation (#283), on Flow's database: whether it is available at all, the limits,
 * the usage it leaves, the token a private issue is read with, and the new workflow's key. The server
 * action (app/actions.ts) runs them in this order:
 *
 *   availability → limits → URL → token → generateDraft → record (+ audit) → save the draft
 *
 * Available: the admin switch (Settings `ai_generation`, off until an admin turns it on), the AI
 * configured (FLOW_AI_API_KEY), Flow not paused (`paused_all`), and the provider not cooling down after
 * COOL_DOWN_FAILURES failures in a row in the last COOL_DOWN_MS.
 *
 * Limits, from `ai_generations` (one row per attempt that reached the AI or the issue host): PER_HOUR
 * and PER_DAY per person, and a daily token cap across everyone (FLOW_AI_DAILY_TOKEN_CAP).
 */
import { randomBytes } from "node:crypto";
import { ulid } from "@asafarim/app-sdk/events";
import type { Keyring } from "../credentials/cipher";
import { CredentialError, credentialKeys, useCredential } from "../credentials/store";
import { getSettings, rowsOf, type Queryable } from "../settings";
import type { IssueRef } from "./issue-url";
import { aiConfigFromEnv, type Usage } from "./provider";

export const PER_HOUR = 5;
export const PER_DAY = 20;
export const DEFAULT_DAILY_TOKEN_CAP = 2_000_000;
export const COOL_DOWN_FAILURES = 3;
export const COOL_DOWN_MS = 5 * 60_000;
/** The outcomes that count as the provider failing (the cool-down). */
const PROVIDER_FAILURES = ["ai_unavailable", "ai_timeout"];

export type Unavailable = "switch_off" | "not_configured" | "paused" | "cooling_down";
export type Availability = { ok: true } | { ok: false; reason: Unavailable };

export async function availability(
  q: Queryable,
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): Promise<Availability> {
  const settings = await getSettings(q);
  if (!settings.aiGeneration) return { ok: false, reason: "switch_off" };
  if (!aiConfigFromEnv(env)) return { ok: false, reason: "not_configured" };
  if (settings.pausedAll) return { ok: false, reason: "paused" };
  const recent = await rowsOf(
    q,
    `SELECT outcome FROM ai_generations WHERE created_at > $1 ORDER BY created_at DESC LIMIT $2`,
    [new Date(now.getTime() - COOL_DOWN_MS), COOL_DOWN_FAILURES],
  );
  if (recent.length === COOL_DOWN_FAILURES && recent.every((r) => PROVIDER_FAILURES.includes(String(r.outcome))))
    return { ok: false, reason: "cooling_down" };
  return { ok: true };
}

/** The daily token cap from the environment (a positive integer), else the default. */
export function dailyTokenCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FLOW_AI_DAILY_TOKEN_CAP);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DAILY_TOKEN_CAP;
}

export type LimitResult = { ok: true } | { ok: false; reason: "rate_limited" | "daily_cap" };

/** Whether `subject` may generate now: per person per hour and per day, and the day's tokens in all. */
export async function checkLimits(
  q: Queryable,
  subject: string,
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): Promise<LimitResult> {
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mine = await rowsOf(
    q,
    `SELECT count(*) FILTER (WHERE created_at > $2) AS hour, count(*) FILTER (WHERE created_at >= $3) AS day
       FROM ai_generations WHERE subject = $1 AND created_at >= LEAST($2, $3)`,
    [subject, hourAgo, dayStart],
  );
  if (Number(mine[0]?.hour ?? 0) >= PER_HOUR || Number(mine[0]?.day ?? 0) >= PER_DAY)
    return { ok: false, reason: "rate_limited" };
  const all = await rowsOf(
    q,
    `SELECT coalesce(sum(input_tokens + output_tokens), 0) AS tokens FROM ai_generations WHERE created_at >= $1`,
    [dayStart],
  );
  if (Number(all[0]?.tokens ?? 0) >= dailyTokenCap(env)) return { ok: false, reason: "daily_cap" };
  return { ok: true };
}

/** One attempt's row: who, how it ended, the model and the tokens. Never a URL or any text. */
export async function recordGeneration(
  q: Queryable,
  r: { subject: string; outcome: string; model?: string; usage?: Usage },
): Promise<void> {
  await q.query(
    `INSERT INTO ai_generations (id, subject, outcome, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ulid(), r.subject, r.outcome, r.model ?? null, r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0],
  );
}

export type TokenResult =
  | { ok: true; token?: string }
  | {
      ok: false;
      error: "credential_not_found" | "credential_wrong_kind" | "credential_not_for_repo" | "credentials_unavailable";
    };

/**
 * The token to read a private issue with: none without a credential; else the credential's, when it is
 * the host's kind (github-token, gitlab-token) and lists the issue's repository or project.
 */
export async function issueToken(
  q: Queryable,
  credentialId: string,
  ref: IssueRef,
  keyring: Keyring | undefined = credentialKeys(),
): Promise<TokenResult> {
  if (!credentialId) return { ok: true };
  try {
    if (ref.host === "github") {
      const c = await useCredential(q, credentialId, "github-token", keyring);
      const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
      if (!c.repos.some((r) => r.toLowerCase() === repo)) return { ok: false, error: "credential_not_for_repo" };
      return { ok: true, token: c.token };
    }
    const c = await useCredential(q, credentialId, "gitlab-token", keyring);
    const project = ref.project.toLowerCase();
    if (!c.projects.some((p) => p.toLowerCase() === project)) return { ok: false, error: "credential_not_for_repo" };
    return { ok: true, token: c.token };
  } catch (err) {
    if (err instanceof CredentialError) {
      if (err.code === "credential_kind_mismatch") return { ok: false, error: "credential_wrong_kind" };
      if (err.code === "credential_not_found") return { ok: false, error: "credential_not_found" };
    }
    return { ok: false, error: "credentials_unavailable" };
  }
}

/**
 * The new workflow's key, from the issue's ids (never from text the AI or the issue chose): `gen-`, the
 * repository's name, the number, 6 random characters. At most 64, kebab-case.
 */
export function generatedKey(ref: IssueRef): string {
  const name = ref.host === "github" ? ref.repo : ref.project.slice(ref.project.lastIndexOf("/") + 1);
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "r$1")
      .slice(0, 36)
      .replace(/-+$/, "") || "issue";
  const suffix = randomBytes(6)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "0")
    .slice(0, 6);
  return `gen-${slug}-${ref.number}-${suffix}`;
}

export interface GeneratedInfo {
  source: { host: "github" | "gitlab"; repo: string; number: number };
  summary: string;
  triggerNote: string;
  notes: Record<string, string>;
  model: string;
}

/** What the builder shows on a draft generated from an issue (the AI's notes and the issue's ids), or null. */
export async function generatedInfo(q: Queryable, workflowKey: string): Promise<GeneratedInfo | null> {
  const rows = await rowsOf(
    q,
    `SELECT g.source_host, g.source_repo, g.source_number, g.summary, g.trigger_note, g.notes, g.model
       FROM generated_drafts g JOIN workflows w ON w.id = g.workflow_id WHERE w.key = $1`,
    [workflowKey],
  );
  const r = rows[0];
  if (!r) return null;
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries((r.notes as Record<string, unknown>) ?? {}))
    if (typeof v === "string") notes[k] = v;
  return {
    source: {
      host: r.source_host as "github" | "gitlab",
      repo: String(r.source_repo),
      number: Number(r.source_number),
    },
    summary: String(r.summary),
    triggerNote: String(r.trigger_note),
    notes,
    model: String(r.model),
  };
}

/** The issue's page, rebuilt from its ids (never a URL anyone typed). */
export function issuePageUrl(source: GeneratedInfo["source"]): string {
  return source.host === "github"
    ? `https://github.com/${source.repo}/issues/${source.number}`
    : `https://gitlab.com/${source.repo}/-/issues/${source.number}`;
}
