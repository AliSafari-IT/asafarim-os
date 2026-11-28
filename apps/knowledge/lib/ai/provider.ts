import "server-only";
/**
 * The AI behind the studio's writing assistance (#360), behind one small interface so the rest of Knowledge (and
 * its tests) don't know the provider. The one provider today is Anthropic's Messages API (Claude) through the
 * official TypeScript SDK. Every request asks for an answer constrained to a JSON schema (structured outputs), with
 * a single billable attempt per reservation. The key is KNOWLEDGE_AI_API_KEY (the encrypted
 * env); nothing here logs a prompt, a draft or an answer.
 */
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = "medium";
export const AI_TIMEOUT_MS = 90_000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateRequest {
  system: string;
  user: string;
  /** The JSON Schema the answer must follow. */
  schema: Record<string, unknown>;
  maxTokens: number;
  /**
   * For long answers (an assessment of up to 30 questions): stream the response, so a large max_tokens never meets
   * an HTTP timeout, and allow this long instead of AI_TIMEOUT_MS.
   */
  long?: { timeoutMs: number };
}

export interface GenerateAnswer {
  /** The parsed JSON answer, unvalidated: lib/ai/operations.ts validates it. */
  answer: unknown;
  usage: Usage;
  model: string;
}

export type AiErrorCode = "timeout" | "unavailable" | "refused" | "invalid_answer";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly usage?: Usage,
    /** The HTTP status or SDK error class, for the log; never a message from the API. */
    readonly detail?: string,
  ) {
    super(`AI ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "AiError";
  }
}

export interface AiProvider {
  readonly provider: string;
  readonly model: string;
  /** The input tokens this exact request would bill, counted by the provider before it is sent. */
  countInput(req: GenerateRequest): Promise<number>;
  generate(req: GenerateRequest): Promise<GenerateAnswer>;
}

export interface AiConfig {
  apiKey: string;
  model: string;
  effort: Effort;
  /** Tokens (input + output) all authors may use per calendar month (UTC). */
  monthlyTokenCap: number;
  /** Tokens one author may use per calendar month (UTC). */
  authorMonthlyTokenCap: number;
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** The AI settings from the environment: none without KNOWLEDGE_AI_API_KEY (the feature is then off). */
export function aiConfigFromEnv(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const apiKey = env.KNOWLEDGE_AI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.KNOWLEDGE_AI_MODEL?.trim() || DEFAULT_MODEL,
    effort: (EFFORTS as readonly string[]).includes(env.KNOWLEDGE_AI_EFFORT ?? "")
      ? (env.KNOWLEDGE_AI_EFFORT as Effort)
      : DEFAULT_EFFORT,
    monthlyTokenCap: positiveInt(env.KNOWLEDGE_AI_MONTHLY_TOKEN_CAP, 2_000_000),
    authorMonthlyTokenCap: positiveInt(env.KNOWLEDGE_AI_AUTHOR_MONTHLY_TOKEN_CAP, 500_000),
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function usageOf(u: Anthropic.Beta.BetaUsage | undefined): Usage {
  const total = { inputTokens: 0, outputTokens: 0 };
  for (const entry of u?.iterations?.length ? u.iterations : [u]) {
    total.inputTokens +=
      num(entry?.input_tokens) + num(entry?.cache_creation_input_tokens) + num(entry?.cache_read_input_tokens);
    total.outputTokens += num(entry?.output_tokens);
  }
  return total;
}

export function createAnthropicProvider(
  config: Pick<AiConfig, "apiKey" | "model" | "effort">,
  /** Tests pass a stand-in fetch; production uses the platform's. */
  opts: { fetch?: typeof fetch } = {},
): AiProvider {
  // A response can be lost after billing; each reservation covers one attempt.
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: AI_TIMEOUT_MS,
    maxRetries: 0,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  // The same request body for counting and for generating, so the count covers what is billed.
  const params = ({ system, user, schema }: GenerateRequest) => ({
    model: config.model,
    system,
    messages: [{ role: "user" as const, content: user }],
    output_config: { effort: config.effort, format: { type: "json_schema" as const, schema } },
  });
  return {
    provider: "anthropic",
    model: config.model,
    async countInput(req) {
      let counted: Anthropic.Beta.BetaMessageTokensCount;
      try {
        counted = await client.beta.messages.countTokens(params(req));
      } catch (err) {
        if (err instanceof Anthropic.APIError)
          throw new AiError("unavailable", undefined, `count_http_${err.status ?? "?"}`);
        throw new AiError("unavailable", undefined, "count_failed");
      }
      const n = counted.input_tokens;
      if (!Number.isSafeInteger(n) || n <= 0) throw new AiError("unavailable", undefined, "count_invalid");
      return n;
    },
    async generate(req) {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = req.long
          ? await client.beta.messages
              .stream({ ...params(req), max_tokens: req.maxTokens }, { timeout: req.long.timeoutMs })
              .finalMessage()
          : await client.beta.messages.create({ ...params(req), max_tokens: req.maxTokens });
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout", undefined, "timeout");
        if (err instanceof Anthropic.APIError) throw new AiError("unavailable", undefined, `http_${err.status ?? "?"}`);
        throw new AiError("unavailable", undefined, "request_failed");
      }
      if (!response.usage) throw new AiError("invalid_answer", undefined, "missing_usage");
      const usage = usageOf(response.usage);
      if (response.stop_reason === "refusal") throw new AiError("refused", usage);
      if (response.stop_reason === "max_tokens") throw new AiError("invalid_answer", usage, "max_tokens");
      const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
      if (typeof text !== "string") throw new AiError("invalid_answer", usage, "no_text");
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        throw new AiError("invalid_answer", usage, "answer_not_json");
      }
      return { answer, usage, model: response.model };
    },
  };
}
