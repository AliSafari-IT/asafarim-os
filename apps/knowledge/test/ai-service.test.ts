import { beforeEach, describe, expect, it, vi } from "vitest";
import { reserve, settle } from "../lib/ai/budget";
import { AiError } from "../lib/ai/provider";
import { AI_PERMISSION, runAiOperation } from "../lib/ai/service";
import { getStudioItem } from "../lib/content";
import { PERMISSIONS } from "../lib/policy";

vi.mock("../lib/content", () => ({ getStudioItem: vi.fn() }));
vi.mock("../lib/ai/budget", () => ({ reserve: vi.fn(), settle: vi.fn() }));

const query = vi.fn();
const pool = { query, connect: vi.fn() } as unknown as Parameters<typeof runAiOperation>[0];
const actor = { subject: "writer", permissions: [AI_PERMISSION, PERMISSIONS.editOwn] };
const caps = { monthlyTokenCap: 20000, authorMonthlyTokenCap: 10000 };
const generate = vi.fn();
const provider = { provider: "fake", model: "configured-model", generate };
const req = {
  itemId: "article",
  baseRevisionId: "revision",
  input: { op: "improve" as const, selection: "Private draft text", instruction: "Clarify" },
};
const reservation = { ok: true, month: "2026-11", tokens: 6500 } as const;

beforeEach(() => {
  vi.resetAllMocks();
  // The service consumes only the ownership field from the studio read.
  vi.mocked(getStudioItem).mockResolvedValue({
    item: { ownerSubject: actor.subject },
  } as NonNullable<Awaited<ReturnType<typeof getStudioItem>>>);
  vi.mocked(reserve).mockResolvedValue(reservation);
});

describe("AI service", () => {
  it("does not spend tokens when an article cannot be found", async () => {
    vi.mocked(getStudioItem).mockResolvedValue(null);
    expect(await runAiOperation(pool, { provider, caps }, actor, req)).toEqual({ ok: false, error: "not_found" });
    expect(reserve).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["publication", "ai_budget"],
    ["author", "ai_author_budget"],
  ] as const)("records the %s budget refusal and skips the provider", async (scope, error) => {
    vi.mocked(reserve).mockResolvedValue({ ok: false, scope });
    expect(await runAiOperation(pool, { provider, caps }, actor, req)).toEqual({ ok: false, error });
    expect(generate).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("INSERT INTO ai_jobs"), [
      expect.any(String),
      "user:writer",
      "improve",
      "article",
      "revision",
      "over_budget",
      `budget_${scope}`,
      null,
      0,
      0,
    ]);
  });

  it("charges reported usage for an unusable answer without recording draft or answer text", async () => {
    generate.mockResolvedValue({
      answer: { unexpected: "Private answer text" },
      model: "fallback-model",
      usage: { inputTokens: 30, outputTokens: 12 },
    });
    expect(await runAiOperation(pool, { provider, caps }, actor, req)).toEqual({ ok: false, error: "ai_empty_answer" });
    expect(settle).toHaveBeenCalledExactlyOnceWith(pool, actor.subject, reservation, 42);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("INSERT INTO ai_jobs"), [
      expect.any(String),
      "user:writer",
      "improve",
      "article",
      "revision",
      "failed",
      "ai_empty_answer",
      "fallback-model",
      30,
      12,
    ]);
  });

  it("releases a timed out request's reservation when no usage was reported", async () => {
    generate.mockRejectedValue(new AiError("timeout"));
    expect(await runAiOperation(pool, { provider, caps }, actor, req)).toEqual({ ok: false, error: "ai_timeout" });
    expect(settle).toHaveBeenCalledExactlyOnceWith(pool, actor.subject, reservation, 0);
  });
});
