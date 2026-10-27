import "server-only";
/**
 * The two outside services a note-to-issue needs (#82), behind small interfaces so tests mock them:
 * the AI that drafts the issue (Claude, through the Anthropic Messages API) and GitHub (the target
 * repo's visibility and labels, and creating the issue). Plain `fetch`, no SDKs. Both are configured
 * by secrets the manifest names (DOCS_AI_API_KEY, DOCS_ISSUES_TOKEN); without them there is none.
 * `pnpm e2e` points both at local mock servers (DOCS_E2E_GITHUB_API_URL, DOCS_E2E_AI_API_URL); an
 * override that isn't a loopback URL is ignored, so a token can never be sent to another host.
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
  /** The HTTP status of an error answer; undefined when the request itself failed. */
  readonly status: number | undefined;
  constructor(reason: string, status?: number) {
    super(`the AI isn't available: ${reason}`);
    this.name = "AiUnavailableError";
    this.status = status;
  }
}

/** The AI answered, but without the issue tool call (or not as JSON): a bad answer, not an outage. */
export class AiNoIssueError extends AiUnavailableError {
  constructor() {
    super("no issue in the answer");
    this.name = "AiNoIssueError";
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
  /**
   * The issue whose body contains `marker`, among those the token's own user opened in `repo` and
   * that were updated at or after `since` (open or closed), or null. Lists issues, never the search
   * API, whose index lags behind a just-created issue.
   */
  findByMarker(repo: string, marker: string, since: Date): Promise<{ url: string; number: number } | null>;
}

/** The parts of a Messages API answer this reads. */
interface MessagesAnswer {
  content?: { type: string; name?: string; input?: unknown }[];
  usage?: Record<string, number>;
}

/** The parts of GitHub's issue this reads. */
interface CreatedIssue {
  html_url?: string;
  number?: number;
  body?: string | null;
}

/** How many pages of 100 issues `findByMarker` reads at most (its window starts when the marker was recorded). */
const MAX_PAGES = 10;

/** A local mock server's URL (`pnpm e2e`), or undefined for anything else. */
export function loopbackUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return local && (url.protocol === "http:" || url.protocol === "https:") ? value.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

export function createAnthropicWriter(opts: {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** The API's origin; `pnpm e2e` points it at a mock. */
  baseUrl?: string;
}): IssueWriter {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://api.anthropic.com";
  return {
    async draft({ system, user }) {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/messages`, {
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
      if (!res.ok) throw new AiUnavailableError(`HTTP ${res.status}`, res.status);
      const data = (await res.json().catch(() => undefined)) as MessagesAnswer | undefined;
      const call = data?.content?.find((c) => c.type === "tool_use" && c.name === ISSUE_TOOL.name);
      if (!call) throw new AiNoIssueError();
      return {
        answer: call.input,
        usage: { inputTokens: data?.usage?.input_tokens ?? 0, outputTokens: data?.usage?.output_tokens ?? 0 },
      };
    },
  };
}

export function createGitHubIssues(opts: {
  token: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** The API's origin; `pnpm e2e` points it at a mock. */
  baseUrl?: string;
}): IssueTracker {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://api.github.com";
  /** `path` is under the API's origin; `repo` names the repo a 401/403/404 is reported for. */
  async function call(repo: string, path: string, init: { method?: string; body?: unknown } = {}) {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
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
  let login: string | undefined;
  return {
    async repo(repo) {
      const data = (await call(repo, `/repos/${repo}`)) as { private?: boolean; visibility?: string };
      return { public: data.private === false || data.visibility === "public" };
    },
    async labels(repo) {
      const data = (await call(repo, `/repos/${repo}/labels?per_page=100`)) as { name?: unknown }[];
      return Array.isArray(data) ? data.map((l) => l.name).filter((n): n is string => typeof n === "string") : [];
    },
    async create(repo, issue) {
      const data = (await call(repo, `/repos/${repo}/issues`, { method: "POST", body: issue })) as CreatedIssue;
      if (typeof data.html_url !== "string" || typeof data.number !== "number") {
        throw new GitHubUnavailableError("the created issue has no URL");
      }
      return { url: data.html_url, number: data.number };
    },
    async findByMarker(repo, marker, since) {
      if (!login) {
        const me = (await call(repo, "/user")) as { login?: unknown };
        if (typeof me.login !== "string") throw new GitHubUnavailableError("the token's user has no login");
        login = me.login;
      }
      const query = `creator=${encodeURIComponent(login)}&since=${since.toISOString()}&state=all&per_page=100`;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = (await call(repo, `/repos/${repo}/issues?${query}&page=${page}`)) as CreatedIssue[];
        if (!Array.isArray(data)) return null;
        const hit = data.find((i) => typeof i.body === "string" && i.body.includes(marker));
        if (hit && typeof hit.html_url === "string" && typeof hit.number === "number") {
          return { url: hit.html_url, number: hit.number };
        }
        if (data.length < 100) return null;
      }
      // More issues than that since the marker was recorded: never guess, try again later.
      throw new GitHubUnavailableError("too many issues to look through");
    },
  };
}

const g = globalThis as unknown as { docsIssueTracker?: IssueTracker | null };

/** The AI, or null without DOCS_AI_API_KEY. The model comes from the app's `ai.model` config. */
export function getIssueWriter(model: string): IssueWriter | null {
  const apiKey = process.env.DOCS_AI_API_KEY;
  if (!apiKey) return null;
  return createAnthropicWriter({ apiKey, model, baseUrl: loopbackUrl(process.env.DOCS_E2E_AI_API_URL) });
}

/** GitHub for issues, one per server process, or null without DOCS_ISSUES_TOKEN. */
export function getIssueTracker(): IssueTracker | null {
  if (g.docsIssueTracker === undefined) {
    const token = process.env.DOCS_ISSUES_TOKEN;
    g.docsIssueTracker = token
      ? createGitHubIssues({ token, baseUrl: loopbackUrl(process.env.DOCS_E2E_GITHUB_API_URL) })
      : null;
  }
  return g.docsIssueTracker;
}
