import { beforeEach, describe, expect, it, vi } from "vitest";
import { reserve, settle } from "../lib/ai/budget";
import { AiError } from "../lib/ai/provider";
import { AI_PERMISSION, reservationFor, runAiOperation } from "../lib/ai/service";
import { buildRequest } from "../lib/ai/operations";
import { getStudioItem } from "../lib/content";
import { PERMISSIONS } from "../lib/policy";

vi.mock("../lib/content", () => ({ getStudioItem: vi.fn() }));
vi.mock("../lib/ai/budget", () => ({ reserve: vi.fn(), settle: vi.fn() }));

const query = vi.fn();
const pool = { query, connect: vi.fn() } as unknown as Parameters<typeof runAiOperation>[0];
const actor = { subject: "writer", permissions: [AI_PERMISSION, PERMISSIONS.editOwn] };
const caps = { monthlyTokenCap: 20000, authorMonthlyTokenCap: 10000 };
const generate = vi.fn();
const countInput = vi.fn();
const provider = { provider: "fake", model: "configured-model", countInput, generate };
const req = {
  itemId: "article",
  baseRevisionId: "revision",
  input: { op: "improve" as const, selection: "Private draft text", instruction: "Clarify" },
};
const reservation = { ok: true, id: "reservation-1", month: "2026-11", tokens: 6500 } as const;

beforeEach(() => {
  vi.resetAllMocks();
  // The service consumes only the ownership field from the studio read.
  vi.mocked(getStudioItem).mockResolvedValue({
    item: { ownerSubject: actor.subject, draftRevisionId: "revision" },
  } as NonNullable<Awaited<ReturnType<typeof getStudioItem>>>);
  vi.mocked(reserve).mockResolvedValue(reservation);
  countInput.mockResolvedValue(1200);
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
    expect(settle).toHaveBeenCalledExactlyOnceWith(pool, "reservation-1", 42);
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

  it("charges the whole reservation when a timed out request reported no usage (it may have been billed)", async () => {
    generate.mockRejectedValue(new AiError("timeout"));
    expect(await runAiOperation(pool, { provider, caps }, actor, req)).toEqual({ ok: false, error: "ai_timeout" });
    expect(settle).toHaveBeenCalledExactlyOnceWith(pool, "reservation-1", reservation.tokens);
  });

  it("reserves the counted input with a margin plus the answer's maximum, not the model's context window", async () => {
    generate.mockResolvedValue({
      answer: { text: "Better" },
      model: "m",
      usage: { inputTokens: 1100, outputTokens: 20 },
    });
    await runAiOperation(pool, { provider, caps }, actor, req);
    const request = buildRequest(req.input);
    expect(countInput).toHaveBeenCalledExactlyOnceWith(request);
    expect(reserve).toHaveBeenCalledExactlyOnceWith(pool, actor.subject, reservationFor(1200, request.maxTokens), caps);
    expect(reservationFor(1200, request.maxTokens)).toBe(1200 + 64 + request.maxTokens);
    expect(reservationFor(10_000, 0)).toBe(10_500);
  });

  it("reserves nothing when the input can't be counted", async () => {
    countInput.mockRejectedValue(new AiError("unavailable"));
    expect(await runAiOperation(pool, { provider, caps }, actor, req)).toEqual({ ok: false, error: "ai_unavailable" });
    expect(reserve).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a request made against an older draft revision before counting or reserving", async () => {
    const stale = { ...req, baseRevisionId: "older-revision" };
    expect(await runAiOperation(pool, { provider, caps }, actor, stale)).toEqual({
      ok: false,
      error: "ai_stale_proposal",
    });
    expect(countInput).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
