/**
 * Read the issue a workflow draft is generated from (#283), through lib/egress like every call Flow
 * makes: HTTPS, the API host only (api.github.com, gitlab.com), pinned DNS, no redirect, 1 MiB at most.
 *
 *   GitHub  GET /repos/<owner>/<repo>/issues/<n>            then  …/comments?per_page=<N>
 *   GitLab  GET /api/v4/projects/<path>/issues/<n>           then  …/notes?sort=asc&order_by=created_at&per_page=<N>
 *
 * Read: the title, the body and the first MAX_COMMENTS comments' text (GitLab's system notes skipped),
 * at most MAX_ISSUE_TEXT_BYTES in all, the rest cut with a marker. Never an author, a label, a link or
 * a date: the AI needs what the issue asks for, not who asked. A token is optional (public issues need
 * none); it goes in the request header only and is never part of what this returns.
 */
import type { EgressRequest, EgressResponse } from "../egress/egress";
import { EgressError } from "../egress/egress";
import type { Queryable } from "../settings";
import type { IssueRef } from "./issue-url";

export const GITHUB_API_HOST = "api.github.com";
export const GITLAB_HOST = "gitlab.com";
export const MAX_COMMENTS = 20;
export const MAX_ISSUE_TEXT_BYTES = 32 * 1024;
export const MAX_TITLE_LENGTH = 256;
export const TRUNCATED = "[truncated]";
/** Each request's time limit (two are made). */
export const ISSUE_TIMEOUT_MS = 15_000;

export interface FetchedIssue {
  title: string;
  body: string;
  comments: string[];
  /** Something was cut to fit MAX_ISSUE_TEXT_BYTES or MAX_COMMENTS. */
  truncated: boolean;
}

export type IssueFetchErrorCode =
  /** 401, 403, 404, 410: missing, private without a token that can see it, or gone. */
  | "no_access"
  /** The URL is a GitHub pull request, not an issue. */
  | "not_an_issue"
  /** Flow is paused (Settings `paused_all`): nothing goes out. */
  | "paused"
  /** The host failed, limited us, answered too much or too slowly, or not as expected. */
  | "unavailable";

export class IssueFetchError extends Error {
  constructor(
    readonly code: IssueFetchErrorCode,
    /** The egress or HTTP detail, for the log (never content). */
    readonly detail?: string,
  ) {
    super(`Issue fetch ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "IssueFetchError";
  }
}

/** The one egress method this needs, so tests pass a fake. */
export interface IssueEgress {
  request(q: Queryable, req: EgressRequest): Promise<EgressResponse>;
}

export interface FetchIssueDeps {
  egress: IssueEgress;
  db: Queryable;
  /** A read-only token for a private issue; none for a public one. */
  token?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");

async function getJson(deps: FetchIssueDeps, req: Omit<EgressRequest, "method" | "timeoutMs">): Promise<unknown> {
  let res: EgressResponse;
  try {
    res = await deps.egress.request(deps.db, { ...req, method: "GET", timeoutMs: ISSUE_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof EgressError) {
      throw new IssueFetchError(err.code === "paused_all" ? "paused" : "unavailable", err.code);
    }
    throw new IssueFetchError("unavailable", "request_failed");
  }
  if ([401, 403, 404, 410].includes(res.status)) {
    // GitHub's rate limit is a 403 with nothing remaining: an outage, not a missing permission.
    if (res.status === 403 && res.headers["x-ratelimit-remaining"] === "0")
      throw new IssueFetchError("unavailable", "http_403_rate_limited");
    throw new IssueFetchError("no_access", `http_${res.status}`);
  }
  if (res.status < 200 || res.status >= 300) throw new IssueFetchError("unavailable", `http_${res.status}`);
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new IssueFetchError("unavailable", "not_json");
  }
}

/** Fit title, body and comments into the size cap: body first, then comments in order. */
export function capIssue(title: string, body: string, comments: readonly string[], more: boolean): FetchedIssue {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  let truncated = more || comments.length > MAX_COMMENTS;
  const t = title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH)}…` : title;
  let budget = MAX_ISSUE_TEXT_BYTES - bytes(t);
  const cut = (s: string): string => {
    if (bytes(s) <= budget) {
      budget -= bytes(s);
      return s;
    }
    truncated = true;
    // Cut on a character boundary, leaving room for the marker.
    let out = Buffer.from(s, "utf8")
      .subarray(0, Math.max(0, budget - bytes(TRUNCATED) - 1))
      .toString("utf8");
    out = out.replace(/�$/, "");
    budget = 0;
    return `${out}\n${TRUNCATED}`;
  };
  const b = cut(body);
  const kept: string[] = [];
  for (const c of comments.slice(0, MAX_COMMENTS)) {
    if (budget <= bytes(TRUNCATED) + 1) {
      truncated = true;
      break;
    }
    kept.push(cut(c));
  }
  return { title: t, body: b, comments: kept, truncated };
}

async function fetchGitHub(ref: Extract<IssueRef, { host: "github" }>, deps: FetchIssueDeps): Promise<FetchedIssue> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "asafarim-flow",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
  };
  const base = `https://${GITHUB_API_HOST}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  const allow = [{ host: GITHUB_API_HOST }];
  const issue = await getJson(deps, { url: base, headers, allow, call: { connector: "generate.github.issue" } });
  if (!isRecord(issue) || typeof issue.title !== "string") throw new IssueFetchError("unavailable", "bad_issue");
  // GitHub serves a pull request at the issues URL too; only issues are drafted from.
  if (issue.pull_request !== undefined && issue.pull_request !== null) throw new IssueFetchError("not_an_issue");
  const count = typeof issue.comments === "number" ? issue.comments : 0;
  let comments: string[] = [];
  if (count > 0) {
    const list = await getJson(deps, {
      url: `${base}/comments?per_page=${MAX_COMMENTS}`,
      headers,
      allow,
      call: { connector: "generate.github.comments" },
    });
    if (!Array.isArray(list)) throw new IssueFetchError("unavailable", "bad_comments");
    comments = list
      .filter(isRecord)
      .map((c) => text(c.body))
      .filter(Boolean);
  }
  return capIssue(issue.title, text(issue.body), comments, count > MAX_COMMENTS);
}

async function fetchGitLab(ref: Extract<IssueRef, { host: "gitlab" }>, deps: FetchIssueDeps): Promise<FetchedIssue> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "asafarim-flow",
    ...(deps.token ? { "PRIVATE-TOKEN": deps.token } : {}),
  };
  const base = `https://${GITLAB_HOST}/api/v4/projects/${encodeURIComponent(ref.project)}/issues/${ref.number}`;
  const allow = [{ host: GITLAB_HOST }];
  const issue = await getJson(deps, { url: base, headers, allow, call: { connector: "generate.gitlab.issue" } });
  if (!isRecord(issue) || typeof issue.title !== "string") throw new IssueFetchError("unavailable", "bad_issue");
  const count = typeof issue.user_notes_count === "number" ? issue.user_notes_count : 0;
  let comments: string[] = [];
  if (count > 0) {
    const list = await getJson(deps, {
      // Twice what is kept: system notes (label and status changes) are skipped, not counted.
      url: `${base}/notes?sort=asc&order_by=created_at&per_page=${MAX_COMMENTS * 2}`,
      headers,
      allow,
      call: { connector: "generate.gitlab.notes" },
    });
    if (!Array.isArray(list)) throw new IssueFetchError("unavailable", "bad_notes");
    comments = list
      .filter(isRecord)
      .filter((n) => n.system !== true)
      .map((n) => text(n.body))
      .filter(Boolean);
  }
  return capIssue(issue.title, text(issue.description), comments, count > MAX_COMMENTS);
}

/** The issue's title, body and first comments; an IssueFetchError when it can't be read. */
export function fetchIssue(ref: IssueRef, deps: FetchIssueDeps): Promise<FetchedIssue> {
  return ref.host === "github" ? fetchGitHub(ref, deps) : fetchGitLab(ref, deps);
}
