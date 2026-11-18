import "server-only";
/**
 * The AI behind the studio's writing assistance (#360), behind one small interface so the rest of Knowledge (and
 * its tests) don't know the provider. The one provider today is Anthropic's Messages API (Claude) through the
 * official TypeScript SDK. Every request asks for an answer constrained to a JSON schema (structured outputs), and
 * opts into the API's server-side fallback when a model declines. The key is KNOWLEDGE_AI_API_KEY (the encrypted
 * env); nothing here logs a prompt, a draft or an answer.
 */
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = "medium";
export const AI_TIMEOUT_MS = 90_000;
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

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
  return {
    inputTokens: num(u?.input_tokens) + num(u?.cache_creation_input_tokens) + num(u?.cache_read_input_tokens),
    outputTokens: num(u?.output_tokens),
  };
}

export function createAnthropicProvider(
  config: Pick<AiConfig, "apiKey" | "model" | "effort">,
  /** Tests pass a stand-in fetch; production uses the platform's. */
  opts: { fetch?: typeof fetch; maxRetries?: number } = {},
): AiProvider {
  // One retry for a connection error or 429/5xx; the budget reservation covers the worst case.
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: AI_TIMEOUT_MS,
    maxRetries: opts.maxRetries ?? 1,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    provider: "anthropic",
    model: config.model,
    async generate({ system, user, schema, maxTokens }) {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create({
          model: config.model,
          max_tokens: maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: config.effort, format: { type: "json_schema", schema } },
        });
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout", undefined, "timeout");
        if (err instanceof Anthropic.APIError) throw new AiError("unavailable", undefined, `http_${err.status ?? "?"}`);
        throw new AiError("unavailable", undefined, "request_failed");
      }
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
