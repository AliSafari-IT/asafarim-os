import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiAction } from "../app/studio/ai-actions";
import type * as providerModule from "../lib/ai/provider";
import { DEFAULT_EFFORT, DEFAULT_MODEL, createAnthropicProvider } from "../lib/ai/provider";
import { runAiOperation } from "../lib/ai/service";
import { db } from "../lib/db";
import { studioGate } from "../lib/studio";

vi.mock("../lib/studio", () => ({ studioGate: vi.fn() }));
vi.mock("../lib/db", () => ({ db: vi.fn() }));
vi.mock("../lib/ai/service", () => ({ runAiOperation: vi.fn() }));
vi.mock("../lib/ai/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof providerModule>()),
  createAnthropicProvider: vi.fn(),
}));

const actor = { subject: "writer", permissions: ["knowledge.content.create", "knowledge.ai.use"] };
const request = {
  itemId: "f3658955-8183-4a24-bbb9-ff7ad669d51d",
  baseRevisionId: "7df8b31a-43cd-4c16-aefe-37dc2b805ffa",
  input: { op: "improve", selection: "  First line.\r\nSecond line.  ", instruction: "  Clarify. " },
};
const pool = { query: vi.fn(), connect: vi.fn() } as unknown as Awaited<ReturnType<typeof db>>;
const provider = { provider: "fake", model: DEFAULT_MODEL, countInput: vi.fn(), generate: vi.fn() };
const providerCache = globalThis as typeof globalThis & { knowledgeAi?: unknown };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("KNOWLEDGE_AI_API_KEY", "test-only");
  vi.stubEnv("KNOWLEDGE_AI_MODEL", "");
  vi.stubEnv("KNOWLEDGE_AI_EFFORT", "");
  vi.stubEnv("KNOWLEDGE_AI_MONTHLY_TOKEN_CAP", "100000");
  vi.stubEnv("KNOWLEDGE_AI_AUTHOR_MONTHLY_TOKEN_CAP", "20000");
  vi.mocked(studioGate).mockResolvedValue({ ok: true, actor });
  vi.mocked(db).mockResolvedValue(pool);
  vi.mocked(createAnthropicProvider).mockReturnValue(provider);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete providerCache.knowledgeAi;
});

function expectNoAiWork() {
  expect(createAnthropicProvider).not.toHaveBeenCalled();
  expect(db).not.toHaveBeenCalled();
  expect(runAiOperation).not.toHaveBeenCalled();
}

describe("studio AI action", () => {
  it("returns ai_off without opening the studio or initializing AI when the key is blank", async () => {
    vi.stubEnv("KNOWLEDGE_AI_API_KEY", " ");
    expect(await aiAction(request)).toEqual({ ok: false, error: "ai_off" });
    expect(studioGate).not.toHaveBeenCalled();
    expectNoAiWork();
  });

  it.each([
    { status: 401, gateError: "sign_in_required", error: "unauthenticated" },
    { status: 403, gateError: "forbidden", error: "forbidden" },
    { status: 503, gateError: "app_unavailable", error: "app_unavailable" },
  ] as const)("stops when the studio gate returns $status", async ({ status, gateError, error }) => {
    vi.mocked(studioGate).mockResolvedValue({ ok: false, status, error: gateError });
    expect(await aiAction(request)).toEqual({ ok: false, error });
    expectNoAiWork();
  });

  it.each([
    ["malformed item ID", { ...request, itemId: "missing" }, "not_found"],
    ["unknown operation", { ...request, input: { op: "unknown" } }, "ai_unknown_operation"],
    ["blank selection", { ...request, input: { op: "improve", selection: "  " } }, "ai_input_empty"],
  ] as const)("rejects a %s before initializing AI", async (_label, raw, error) => {
    expect(await aiAction(raw)).toEqual({ ok: false, error });
    expectNoAiWork();
  });

  it("passes the actor, revision, limits and normalized input to the service and returns only the proposal", async () => {
    const proposal = { kind: "text", text: "Clearer wording." } as const;
    vi.mocked(runAiOperation).mockResolvedValue({ ok: true, proposal, model: "internal-model" });
    expect(await aiAction(request)).toEqual({ ok: true, proposal });
    expect(createAnthropicProvider).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_MODEL, effort: DEFAULT_EFFORT }),
    );
    expect(db).toHaveBeenCalledOnce();
    expect(runAiOperation).toHaveBeenCalledExactlyOnceWith(
      pool,
      { provider, caps: expect.objectContaining({ monthlyTokenCap: 100000, authorMonthlyTokenCap: 20000 }) },
      actor,
      {
        itemId: request.itemId,
        baseRevisionId: request.baseRevisionId,
        input: { op: "improve", selection: "First line.\nSecond line.", instruction: "Clarify." },
      },
    );
  });

  it("preserves a service refusal without returning a proposal", async () => {
    vi.mocked(runAiOperation).mockResolvedValue({ ok: false, error: "ai_author_budget" });
    expect(await aiAction(request)).toEqual({ ok: false, error: "ai_author_budget" });
  });
});
