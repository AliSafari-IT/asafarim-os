import "server-only";
/**
 * The two outside services a note-to-issue needs (#82), behind small interfaces so tests mock them:
 * the AI that drafts the issue (Claude, through the Anthropic Messages API) and GitHub (the target
 * repo's visibility and labels, and creating the issue). Plain `fetch`, no SDKs. Both are configured
 * by secrets the manifest names (DOCS_AI_API_KEY, DOCS_ISSUES_TOKEN); without them there is none.
 */
import { ISSUE_TOOL } from "./issue-draft";

export const AI_TIMEOUT_MS = 60_000;
export const GITHUB_TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;

/** The AI took too long: the preview offers "Try again". */
export class AiTimeoutError extends Error {
  constructor() {
    super("the AI took too long to answer");
    this.name = "AiTimeoutError";
  }
}

/** The AI service failed or answered without the tool call. */
export class AiUnavailableError extends Error {
  constructor(reason: string) {
    super(`the AI isn't available: ${reason}`);
    this.name = "AiUnavailableError";
  }
}

/** The issues token can't see or write the repo (GitHub's 401, 403 or 404). */
export class NoRepoAccessError extends Error {
  constructor(readonly repo: string) {
    super(`No access to ${repo}`);
    this.name = "NoRepoAccessError";
  }
}

/** GitHub failed for another reason (a 5xx, a timeout, the network). */
export class GitHubUnavailableError extends Error {
  constructor(reason: string) {
    super(`GitHub isn't available: ${reason}`);
    this.name = "GitHubUnavailableError";
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface IssueWriter {
  /** The tool call's input, unvalidated: the caller validates it. */
  draft(prompt: { system: string; user: string }): Promise<{ answer: unknown; usage: Usage }>;
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueTracker {
  repo(repo: string): Promise<{ public: boolean }>;
  labels(repo: string): Promise<string[]>;
  create(repo: string, issue: NewIssue): Promise<{ url: string; number: number }>;
}

/** The parts of a Messages API answer this reads. */
interface MessagesAnswer {
  content?: { type: string; name?: string; input?: unknown }[];
  usage?: Record<string, number>;
}

/** The parts of GitHub's created issue this reads. */
interface CreatedIssue {
  html_url?: string;
  number?: number;
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

export function createAnthropicWriter(opts: {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): IssueWriter {
  const doFetch = opts.fetch ?? fetch;
  return {
    async draft({ system, user }) {
      let res: Response;
      try {
        res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: 4096,
            system,
            messages: [{ role: "user", content: user }],
            tools: [ISSUE_TOOL],
            // Newer models reject a forced tool_choice (HTTP 400); the system prompt says to call the tool.
            tool_choice: { type: "auto" },
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? AI_TIMEOUT_MS),
        });
      } catch (err) {
        if (isAbort(err)) throw new AiTimeoutError();
        throw new AiUnavailableError("the request failed");
      }
      if (!res.ok) throw new AiUnavailableError(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => undefined)) as MessagesAnswer | undefined;
      const call = data?.content?.find((c) => c.type === "tool_use" && c.name === ISSUE_TOOL.name);
      if (!call) throw new AiUnavailableError("no issue in the answer");
      return {
        answer: call.input,
        usage: { inputTokens: data?.usage?.input_tokens ?? 0, outputTokens: data?.usage?.output_tokens ?? 0 },
      };
    },
  };
}

export function createGitHubIssues(opts: { token: string; fetch?: Fetch; timeoutMs?: number }): IssueTracker {
  const doFetch = opts.fetch ?? fetch;
  async function call(repo: string, pathAndQuery: string, init: { method?: string; body?: unknown } = {}) {
    let res: Response;
    try {
      res = await doFetch(`https://api.github.com/repos/${repo}${pathAndQuery}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${opts.token}`,
          "x-github-api-version": "2022-11-28",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GitHubUnavailableError(isAbort(err) ? "timed out" : "the request failed");
    }
    // GitHub answers 404 for a private repo the token can't see, 403 for one it can't write.
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new NoRepoAccessError(repo);
    if (!res.ok) throw new GitHubUnavailableError(`HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  }
  return {
    async repo(repo) {
      const data = (await call(repo, "")) as { private?: boolean; visibility?: string };
      return { public: data.private === false || data.visibility === "public" };
    },
    async labels(repo) {
      const data = (await call(repo, "/labels?per_page=100")) as { name?: unknown }[];
      return Array.isArray(data) ? data.map((l) => l.name).filter((n): n is string => typeof n === "string") : [];
    },
    async create(repo, issue) {
      const data = (await call(repo, "/issues", { method: "POST", body: issue })) as CreatedIssue;
      if (typeof data.html_url !== "string" || typeof data.number !== "number") {
        throw new GitHubUnavailableError("the created issue has no URL");
      }
      return { url: data.html_url, number: data.number };
    },
  };
}

const g = globalThis as unknown as { docsIssueTracker?: IssueTracker | null };

/** The AI, or null without DOCS_AI_API_KEY. The model comes from the app's `ai.model` config. */
export function getIssueWriter(model: string): IssueWriter | null {
  const apiKey = process.env.DOCS_AI_API_KEY;
  if (!apiKey) return null;
  return createAnthropicWriter({ apiKey, model });
}

/** GitHub for issues, one per server process, or null without DOCS_ISSUES_TOKEN. */
export function getIssueTracker(): IssueTracker | null {
  if (g.docsIssueTracker === undefined) {
    const token = process.env.DOCS_ISSUES_TOKEN;
    g.docsIssueTracker = token ? createGitHubIssues({ token }) : null;
  }
  return g.docsIssueTracker;
}
