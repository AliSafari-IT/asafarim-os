/**
 * The GitHub connectors, through lib/egress to api.github.com only, with a `github-token` credential
 * that may act on the repositories its meta lists (else `repo_not_allowed`, before any call):
 *
 *   github.issue.create    repo, title, body, labels  → { number, url }
 *   github.comment.create  repo, number, body         → { id, url }
 *   github.labels.add      repo, number, labels       → { labels }
 *   github.issue.close     repo, number, reason       → { state }
 *
 * Labels must exist in the repository already (`label_not_found`): nothing creates one. GitHub's answers:
 * 401, 403, 404 and 410 `no_repo_access`; 422 `invalid_request`; 5xx, a rate limit, no answer in time
 * `github_unavailable` (retryable).
 *
 * Duplicate guard (connectors run at least once): what `create` writes carries a marker in its body,
 * `<!-- asafarim-flow:<runId>:<stepKey> -->`. Before creating, the issues (or the issue's comments) the
 * token's user wrote since the run started are searched for it; one that carries it is the step's
 * result, and nothing is created again. Closing and adding labels are idempotent on GitHub's side.
 */
import { z } from "zod";
import { ConnectorError } from "../engine/connector-error";
import type { Connector, ConnectorContext } from "../engine/connectors";
import type { EgressResponse } from "../egress/egress";
import { credentialField } from "../workflow/fields";
import { templatedText } from "../workflow/templates";
import { egressFailure } from "./failures";

export const GITHUB_API = "api.github.com";
/** How far before the run's start the duplicate search looks (clocks differ). */
const SINCE_MARGIN_MS = 5 * 60_000;
/** Pages of 100 read at most: labels, issues, comments. */
const MAX_PAGES = 10;
/** A call is several requests (the user, labels, the duplicate search, the write), each up to 10 s. */
const TIMEOUT_MS = 60_000;

const Repo = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
const Credential = credentialField("github-token");
/** An issue number, or a placeholder for one (`{{steps.create.output.number}}`). */
const IssueNumber = z.union([z.number().int().positive(), templatedText(200)]);
const Labels = z.array(templatedText(50)).max(20);

/** The marker `create` appends to what it writes. */
export const markerOf = (ctx: Pick<ConnectorContext, "runId" | "stepKey">) =>
  `<!-- asafarim-flow:${ctx.runId}:${ctx.stepKey} -->`;

function numberOf(value: number | string): number {
  if (typeof value === "number") return value;
  const n = /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : 0;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new ConnectorError("invalid_request", false, "The issue number isn't one.");
  return n;
}

function labelsOf(labels: readonly string[] | undefined): string[] {
  const out = [...new Set((labels ?? []).map((l) => l.trim()))];
  if (out.some((l) => !l)) throw new ConnectorError("invalid_request", false, "A label is empty.");
  return out;
}

function statusFailure(res: EgressResponse, repo: string): never {
  const s = res.status;
  const limited = s === 429 || (s === 403 && res.headers["x-ratelimit-remaining"] === "0");
  if (limited || s >= 500) throw new ConnectorError("github_unavailable", true, `GitHub answered ${s}.`);
  if ([401, 403, 404, 410].includes(s))
    throw new ConnectorError("no_repo_access", false, `The token can't reach ${repo} (GitHub answered ${s}).`);
  throw new ConnectorError("invalid_request", false, `GitHub refused the request (${s}).`);
}

/** GitHub as one credential may use it, for one repository. */
async function client(ctx: ConnectorContext, credential: string, repo: string) {
  const cred = await ctx.credentials.use(credential, "github-token");
  if (!cred.repos.some((r) => r.toLowerCase() === repo.toLowerCase()))
    throw new ConnectorError("repo_not_allowed", false, `The credential may not act on ${repo}.`);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${cred.token}`,
    "User-Agent": "asafarim-flow",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  /** One call; its JSON answer when the status is 2xx. */
  async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    let res: EgressResponse;
    try {
      res = await ctx.egress.request({
        method,
        url: `https://${GITHUB_API}${path}`,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        allow: [{ host: GITHUB_API }],
      });
    } catch (err) {
      egressFailure(err, "github_unavailable");
    }
    if (res.status < 200 || res.status >= 300) statusFailure(res, repo);
    try {
      return JSON.parse(res.body.toString("utf8")) as T;
    } catch {
      throw new ConnectorError("github_unavailable", true, "GitHub's answer isn't JSON.");
    }
  }

  /** Every page (of 100) of a list, up to MAX_PAGES. */
  async function list<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const items = await call<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new ConnectorError("github_unavailable", true, "GitHub's answer isn't a list.");
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  /** Refuse a label the repository doesn't have (GitHub compares names case-insensitively). */
  async function requireLabels(labels: readonly string[]) {
    if (!labels.length) return;
    const have = new Set((await list<{ name: string }>(`/repos/${repo}/labels`)).map((l) => l.name.toLowerCase()));
    const missing = labels.filter((l) => !have.has(l.toLowerCase()));
    if (missing.length)
      throw new ConnectorError("label_not_found", false, `No label ${missing.join(", ")} in ${repo}.`);
  }

  /** The login of the token's user: whose issues and comments the duplicate guard looks at. */
  const login = async () => (await call<{ login: string }>("GET", "/user")).login;

  return { call, list, requireLabels, login };
}

/** `since` for the duplicate search: the run's start, a margin before it. */
const sinceOf = (ctx: ConnectorContext) => new Date(ctx.runStartedAt.getTime() - SINCE_MARGIN_MS).toISOString();

const IssueCreateInput = z.strictObject({
  credential: Credential,
  repo: Repo,
  title: templatedText(256),
  body: templatedText(60_000).optional(),
  labels: Labels.optional(),
});
const IssueCreateOutput = z.strictObject({
  number: z.number().int().nonnegative(),
  url: z.string(),
  simulated: z.literal(true).optional(),
});

interface IssueRow {
  number: number;
  html_url: string;
  body?: string | null;
  pull_request?: unknown;
}

export const GITHUB_ISSUE_CREATE: Connector<z.infer<typeof IssueCreateInput>, z.infer<typeof IssueCreateOutput>> = {
  type: "github.issue.create",
  input: IssueCreateInput,
  output: IssueCreateOutput,
  timeoutMs: TIMEOUT_MS,
  simulate: (input) => ({ number: 0, url: `https://github.com/${input.repo}/issues`, simulated: true }),
  async run(ctx, input) {
    const title = input.title.trim();
    if (!title) throw new ConnectorError("invalid_request", false, "The title is empty.");
    const labels = labelsOf(input.labels);
    const gh = await client(ctx, input.credential, input.repo);
    await gh.requireLabels(labels);
    const marker = markerOf(ctx);
    const creator = encodeURIComponent(await gh.login());
    const mine = await gh.list<IssueRow>(
      `/repos/${input.repo}/issues?creator=${creator}&since=${encodeURIComponent(sinceOf(ctx))}&state=all`,
    );
    const done = mine.find((i) => !i.pull_request && (i.body ?? "").includes(marker));
    if (done) {
      ctx.log.info("flow.github.duplicate_avoided", { kind: "issue", number: done.number });
      return { number: done.number, url: done.html_url };
    }
    const body = input.body ? `${input.body}\n\n${marker}` : marker;
    const created = await gh.call<IssueRow>("POST", `/repos/${input.repo}/issues`, {
      title,
      body,
      ...(labels.length ? { labels } : {}),
    });
    return { number: created.number, url: created.html_url };
  },
};

const CommentCreateInput = z.strictObject({
  credential: Credential,
  repo: Repo,
  number: IssueNumber,
  body: templatedText(60_000),
});
const CommentCreateOutput = z.strictObject({
  id: z.number().int().nonnegative(),
  url: z.string(),
  simulated: z.literal(true).optional(),
});

interface CommentRow {
  id: number;
  html_url: string;
  body?: string | null;
  user?: { login?: string } | null;
}

export const GITHUB_COMMENT_CREATE: Connector<
  z.infer<typeof CommentCreateInput>,
  z.infer<typeof CommentCreateOutput>
> = {
  type: "github.comment.create",
  input: CommentCreateInput,
  output: CommentCreateOutput,
  timeoutMs: TIMEOUT_MS,
  simulate: (input) => ({ id: 0, url: `https://github.com/${input.repo}/issues/${input.number}`, simulated: true }),
  async run(ctx, input) {
    const number = numberOf(input.number);
    if (!input.body.trim()) throw new ConnectorError("invalid_request", false, "The comment is empty.");
    const gh = await client(ctx, input.credential, input.repo);
    const marker = markerOf(ctx);
    const me = await gh.login();
    const comments = await gh.list<CommentRow>(
      `/repos/${input.repo}/issues/${number}/comments?since=${encodeURIComponent(sinceOf(ctx))}`,
    );
    // Only the token's own comments: someone else quoting the marker can't stop this one.
    const done = comments.find((c) => c.user?.login === me && (c.body ?? "").includes(marker));
    if (done) {
      ctx.log.info("flow.github.duplicate_avoided", { kind: "comment", id: done.id });
      return { id: done.id, url: done.html_url };
    }
    const created = await gh.call<CommentRow>("POST", `/repos/${input.repo}/issues/${number}/comments`, {
      body: `${input.body}\n\n${marker}`,
    });
    return { id: created.id, url: created.html_url };
  },
};

const LabelsAddInput = z.strictObject({
  credential: Credential,
  repo: Repo,
  number: IssueNumber,
  labels: Labels.min(1),
});
const LabelsAddOutput = z.strictObject({ labels: z.array(z.string()), simulated: z.literal(true).optional() });

export const GITHUB_LABELS_ADD: Connector<z.infer<typeof LabelsAddInput>, z.infer<typeof LabelsAddOutput>> = {
  type: "github.labels.add",
  input: LabelsAddInput,
  output: LabelsAddOutput,
  timeoutMs: TIMEOUT_MS,
  simulate: (input) => ({ labels: input.labels, simulated: true }),
  async run(ctx, input) {
    const number = numberOf(input.number);
    const labels = labelsOf(input.labels);
    const gh = await client(ctx, input.credential, input.repo);
    await gh.requireLabels(labels);
    const now = await gh.call<{ name: string }[]>("POST", `/repos/${input.repo}/issues/${number}/labels`, { labels });
    return { labels: Array.isArray(now) ? now.map((l) => l.name) : labels };
  },
};

const IssueCloseInput = z.strictObject({
  credential: Credential,
  repo: Repo,
  number: IssueNumber,
  reason: z.enum(["completed", "not_planned"]).default("completed"),
});
const IssueCloseOutput = z.strictObject({ state: z.string(), simulated: z.literal(true).optional() });

export const GITHUB_ISSUE_CLOSE: Connector<z.infer<typeof IssueCloseInput>, z.infer<typeof IssueCloseOutput>> = {
  type: "github.issue.close",
  input: IssueCloseInput,
  output: IssueCloseOutput,
  timeoutMs: TIMEOUT_MS,
  simulate: () => ({ state: "closed", simulated: true }),
  async run(ctx, input) {
    const number = numberOf(input.number);
    const gh = await client(ctx, input.credential, input.repo);
    const issue = await gh.call<{ state: string }>("PATCH", `/repos/${input.repo}/issues/${number}`, {
      state: "closed",
      state_reason: input.reason,
    });
    return { state: issue.state };
  },
};
