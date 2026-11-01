/**
 * Generate a workflow draft from a GitHub or GitLab issue URL (#283): parse the URL, read the issue,
 * strip secrets, ask the AI, and turn its answer into a draft that is safe to show. Every step's failure
 * is a plain error code; no step publishes, activates or runs anything. What reaches the result: the
 * draft and the AI's notes for the person, and ids and counts for the audit (host, repository, number,
 * model, tokens). Never the issue text or the prompt.
 *
 * The permission, the admin switch, the limits, the audit entry and saving the draft are the caller's
 * (the server action).
 */
import { toDraft, answerJsonSchema, type GeneratedDraft } from "./draft";
import { fetchIssue, IssueFetchError, type FetchedIssue, type FetchIssueDeps } from "./issue-source";
import { parseIssueUrl, sourceOf, type IssueRef } from "./issue-url";
import { systemPrompt, userMessage } from "./prompt";
import { GeneratorError, type DraftGenerator, type Usage } from "./provider";
import { redactSecrets } from "./redact";

export { parseIssueUrl, sourceOf, type IssueRef } from "./issue-url";
export { redactSecrets } from "./redact";
export { assertNoConfiguredOutbound, toDraft, type GeneratedDraft } from "./draft";
export { aiConfigFromEnv, createAnthropicGenerator, GeneratorError, type DraftGenerator, type Usage } from "./provider";
export { fetchIssue, IssueFetchError, type FetchedIssue } from "./issue-source";

export type GenerateErrorCode =
  | "invalid_url"
  | "issue_no_access"
  | "not_an_issue"
  | "issue_unavailable"
  | "paused"
  | "ai_timeout"
  | "ai_unavailable"
  | "ai_refused"
  | "invalid_ai_answer";

export type Source = ReturnType<typeof sourceOf>;

export type GenerateResult =
  | { ok: true; draft: GeneratedDraft; source: Source; model: string; usage: Usage; redactions: number }
  | {
      ok: false;
      error: GenerateErrorCode;
      /** Known once the URL parsed. */
      source?: Source;
      model?: string;
      /** Tokens used, when the AI was called and said. */
      usage?: Usage;
      /** For the log: the egress or HTTP detail, or the draft's problems (never content). */
      detail?: string;
      problems?: string[];
    };

export interface GenerateDeps {
  generator: DraftGenerator;
  /** The connector node types a draft may use (the registry's). */
  connectorTypes: readonly string[];
  /** Reads the issue (lib/generate/issue-source.ts); tests pass a fake. */
  loadIssue?: (ref: IssueRef, deps: FetchIssueDeps) => Promise<FetchedIssue>;
  fetchDeps: FetchIssueDeps;
}

const ISSUE_ERRORS = {
  no_access: "issue_no_access",
  not_an_issue: "not_an_issue",
  paused: "paused",
  unavailable: "issue_unavailable",
} as const satisfies Record<IssueFetchError["code"], GenerateErrorCode>;

const AI_ERRORS = {
  timeout: "ai_timeout",
  unavailable: "ai_unavailable",
  refused: "ai_refused",
  invalid_answer: "invalid_ai_answer",
  paused: "paused",
} as const satisfies Record<GeneratorError["code"], GenerateErrorCode>;

/** Redact the issue's text, every part of it. */
function redactIssue(issue: FetchedIssue): { issue: FetchedIssue; redactions: number } {
  let redactions = 0;
  const r = (s: string) => {
    const out = redactSecrets(s);
    redactions += out.redactions;
    return out.text;
  };
  return {
    issue: { ...issue, title: r(issue.title), body: r(issue.body), comments: issue.comments.map(r) },
    redactions,
  };
}

/** A draft for workflow `key` from the issue at `url`. */
export async function generateDraft(url: string, key: string, deps: GenerateDeps): Promise<GenerateResult> {
  const ref = parseIssueUrl(url);
  if (!ref) return { ok: false, error: "invalid_url" };
  const source = sourceOf(ref);

  let fetched: FetchedIssue;
  try {
    fetched = await (deps.loadIssue ?? fetchIssue)(ref, deps.fetchDeps);
  } catch (err) {
    if (err instanceof IssueFetchError) return { ok: false, error: ISSUE_ERRORS[err.code], source, detail: err.detail };
    return { ok: false, error: "issue_unavailable", source, detail: "fetch_failed" };
  }
  const { issue, redactions } = redactIssue(fetched);

  const model = deps.generator.model;
  let out: Awaited<ReturnType<DraftGenerator["generate"]>>;
  try {
    out = await deps.generator.generate({
      system: systemPrompt(deps.connectorTypes),
      user: userMessage(ref.host, issue),
      schema: answerJsonSchema(deps.connectorTypes),
    });
  } catch (err) {
    if (err instanceof GeneratorError)
      return { ok: false, error: AI_ERRORS[err.code], source, model, usage: err.usage, detail: err.detail };
    return { ok: false, error: "ai_unavailable", source, model, detail: "generate_failed" };
  }
  const { answer, usage, model: answeredBy } = out;

  let drafted: ReturnType<typeof toDraft>;
  try {
    drafted = toDraft(answer, key, deps.connectorTypes);
  } catch {
    // assertNoConfiguredOutbound: never shown, never saved.
    return { ok: false, error: "invalid_ai_answer", source, model: answeredBy, usage, detail: "configured_outbound" };
  }
  if (!drafted.ok)
    return { ok: false, error: "invalid_ai_answer", source, model: answeredBy, usage, problems: drafted.problems };
  return { ok: true, draft: drafted.draft, source, model: answeredBy, usage, redactions };
}
