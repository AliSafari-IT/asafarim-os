"use server";
/**
 * The studio's AI action (#360): one server action for the four operations. It passes the studio gate, checks the
 * operation's input, and runs it (lib/ai/service.ts). The answer is a proposal for the editor, never a save.
 */
import { parseInput, type Proposal } from "@/lib/ai/operations";
import { aiConfigFromEnv, createAnthropicProvider, type AiProvider } from "@/lib/ai/provider";
import { runAiOperation } from "@/lib/ai/service";
import { isUuid } from "@/lib/content";
import { db } from "@/lib/db";
import { studioGate } from "@/lib/studio";

export type AiActionResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

const globalForAi = globalThis as unknown as { knowledgeAi?: { key: string; provider: AiProvider } };

export async function aiAction(raw: {
  itemId: string;
  baseRevisionId: string;
  input: Record<string, unknown>;
}): Promise<AiActionResult> {
  const config = aiConfigFromEnv();
  if (!config) return { ok: false, error: "ai_off" };
  const g = await studioGate();
  if (!g.ok) return { ok: false, error: g.status === 401 ? "unauthenticated" : g.error };
  if (!isUuid(String(raw?.itemId ?? "")) || typeof raw?.baseRevisionId !== "string") {
    return { ok: false, error: "not_found" };
  }
  const input = parseInput(raw.input ?? {});
  if (!input.ok) return input;
  const key = `${config.model}|${config.effort}`;
  if (globalForAi.knowledgeAi?.key !== key) {
    globalForAi.knowledgeAi = { key, provider: createAnthropicProvider(config) };
  }
  const r = await runAiOperation(await db(), { provider: globalForAi.knowledgeAi.provider, caps: config }, g.actor, {
    itemId: raw.itemId,
    baseRevisionId: raw.baseRevisionId,
    input: input.input,
  });
  return r.ok ? { ok: true, proposal: r.proposal } : r;
}
