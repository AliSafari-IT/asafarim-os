/**
 * Run one AI operation for one author on one article (#360): permission and ownership first, then the budget
 * reservation, then the provider, then settle and log. The result is a proposal for the editor; nothing is saved
 * to the article here, so a failure (or an outage) never touches the draft.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getStudioItem } from "../content";
import { canEdit, type Actor } from "../policy";
import { reserve, settle, type Caps } from "./budget";
import { buildRequest, toProposal, type OperationInput, type Proposal } from "./operations";
import { AiError, type AiProvider } from "./provider";

export const AI_PERMISSION = "knowledge.ai.use";

type Pool = Pick<pg.Pool, "connect" | "query">;

export type AiResult = { ok: true; proposal: Proposal; model: string } | { ok: false; error: string };

async function log(
  pool: Pick<Pool, "query">,
  row: {
    actor: Actor;
    op: string;
    itemId: string;
    baseRevisionId: string;
    status: "succeeded" | "failed" | "refused" | "over_budget";
    error?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  },
) {
  await pool.query(
    `INSERT INTO ai_jobs (id, actor, operation, item_id, base_revision_id, status, error_code, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      `user:${row.actor.subject}`,
      row.op,
      row.itemId,
      row.baseRevisionId,
      row.status,
      row.error ?? null,
      row.model ?? null,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
    ],
  );
}

export async function runAiOperation(
  pool: Pool,
  deps: { provider: AiProvider; caps: Caps },
  actor: Actor,
  req: { itemId: string; baseRevisionId: string; input: OperationInput },
): Promise<AiResult> {
  if (!actor.permissions.includes(AI_PERMISSION)) return { ok: false, error: "forbidden" };
  // Only on an article the person may edit: the proposal is for their draft.
  const found = await getStudioItem(pool, actor, req.itemId, { limit: 1 });
  if (!found) return { ok: false, error: "not_found" };
  if (!canEdit(actor, found.item)) return { ok: false, error: "forbidden" };

  const revision = found.item.draftRevisionId;
  if (req.baseRevisionId !== revision) return { ok: false, error: "ai_stale_proposal" };
  const request = buildRequest(req.input);
  let limits: Awaited<ReturnType<AiProvider["modelLimits"]>>;
  try {
    limits = await deps.provider.modelLimits();
  } catch {
    return { ok: false, error: "ai_unavailable" };
  }
  const ceiling = limits.maxInput + request.maxTokens;
  const base = { actor, op: req.input.op, itemId: req.itemId, baseRevisionId: revision };
  const reservation = await reserve(pool, actor.subject, ceiling, deps.caps);
  if (!reservation.ok) {
    await log(pool, { ...base, status: "over_budget", error: `budget_${reservation.scope}` });
    return { ok: false, error: reservation.scope === "author" ? "ai_author_budget" : "ai_budget" };
  }

  let used = reservation.tokens;
  try {
    const answer = await deps.provider.generate(request, limits.model);
    used = answer.usage.inputTokens + answer.usage.outputTokens;
    const proposal = toProposal(req.input.op, answer.answer);
    await log(pool, {
      ...base,
      status: proposal.ok ? "succeeded" : "failed",
      error: proposal.ok ? undefined : proposal.error,
      model: answer.model,
      inputTokens: answer.usage.inputTokens,
      outputTokens: answer.usage.outputTokens,
    });
    return proposal.ok ? { ok: true, proposal: proposal.proposal, model: answer.model } : proposal;
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("unavailable", undefined, "unexpected");
    if (e.usage) used = e.usage.inputTokens + e.usage.outputTokens;
    await log(pool, {
      ...base,
      status: e.code === "refused" ? "refused" : "failed",
      error: `${e.code}${e.detail ? `:${e.detail}` : ""}`.slice(0, 80),
      inputTokens: e.usage?.inputTokens,
      outputTokens: e.usage?.outputTokens,
    });
    return { ok: false, error: `ai_${e.code}` };
  } finally {
    await settle(pool, reservation.id, used);
  }
}
