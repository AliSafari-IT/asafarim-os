import { describe, expect, it } from "vitest";
import { buildRequest } from "../lib/ai/operations";
import { aiConfigFromEnv, AiError, createAnthropicProvider, DEFAULT_MODEL } from "../lib/ai/provider";

const answer = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: DEFAULT_MODEL,
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ text: "Better." }) }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
  ...over,
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const cfg = { apiKey: "test-key-not-real", model: DEFAULT_MODEL, effort: "medium" as const };
const req = { system: "S", user: "U", schema: { type: "object" }, maxTokens: 1000 };

describe("the Anthropic provider", () => {
  it("asks for a structured answer in one attempt, and reads the usage", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const p = createAnthropicProvider(cfg, { fetch: fakeFetch(200, answer(), seen) });
    const r = await p.generate(req, DEFAULT_MODEL);
    expect(r).toEqual({
      answer: { text: "Better." },
      usage: { inputTokens: 105, outputTokens: 20 },
      model: DEFAULT_MODEL,
    });
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(seen[0]!.url).toContain("/v1/messages");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      system: "S",
      messages: [{ role: "user", content: "U" }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("fallbacks");
  });

  it("sends an outline without array limits and sums all billed iterations", async () => {
    const seen: { init?: RequestInit }[] = [];
    const iteration = { input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 1, output_tokens: 5 };
    const provider = createAnthropicProvider(cfg, {
      fetch: fakeFetch(
        200,
        answer({
          usage: {
            input_tokens: 999,
            iterations: [iteration, iteration],
          },
        }),
        seen,
      ),
    });
    const result = await provider.generate(buildRequest({ op: "outline", brief: "hooks", title: "" }), DEFAULT_MODEL);
    expect(JSON.stringify(JSON.parse(String(seen[0]?.init?.body)).output_config)).not.toContain("maxItems");
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 10 });
  });

  it("turns refusals, cut-off and non-JSON answers, and API errors into typed errors", async () => {
    const cases: [number, unknown, string][] = [
      [200, answer({ stop_reason: "refusal", content: [] }), "refused"],
      [200, answer({ stop_reason: "max_tokens" }), "invalid_answer"],
      [200, answer({ content: [{ type: "text", text: "not json" }] }), "invalid_answer"],
      [200, answer({ content: [] }), "invalid_answer"],
      [500, { type: "error", error: { type: "api_error", message: "secret detail" } }, "unavailable"],
      [400, { type: "error", error: { type: "invalid_request_error", message: "x" } }, "unavailable"],
    ];
    for (const [status, body, code] of cases) {
      const p = createAnthropicProvider(cfg, { fetch: fakeFetch(status, body) });
      const err = await p.generate(req, DEFAULT_MODEL).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe(code);
      expect((err as AiError).message).not.toContain("secret detail");
    }
  });

  it("is off without a key, and reads its settings and caps from the environment", () => {
    expect(aiConfigFromEnv({})).toBeNull();
    expect(aiConfigFromEnv({ KNOWLEDGE_AI_API_KEY: " " })).toBeNull();
    expect(aiConfigFromEnv({ KNOWLEDGE_AI_API_KEY: "k" })).toEqual({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "medium",
      monthlyTokenCap: 2_000_000,
      authorMonthlyTokenCap: 500_000,
    });
    expect(
      aiConfigFromEnv({
        KNOWLEDGE_AI_API_KEY: "k",
        KNOWLEDGE_AI_EFFORT: "max",
        KNOWLEDGE_AI_MONTHLY_TOKEN_CAP: "-5",
        KNOWLEDGE_AI_AUTHOR_MONTHLY_TOKEN_CAP: "1000",
      }),
    ).toMatchObject({ effort: "medium", monthlyTokenCap: 2_000_000, authorMonthlyTokenCap: 1000 });
  });
});
