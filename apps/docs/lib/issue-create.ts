import "server-only";
/**
 * Creating a GitHub issue from a note (#82), shared by the HTTP route (POST /api/notes/:id/issue)
 * and Flow's approval (lib/issue-create-handler.ts): no link to the reader (checked first, without
 * asking GitHub), the repo's visibility asked now (it may have been made public since the draft) and
 * acknowledged when public, labels checked against the repo's own, then the issue. Neither caller's
 * transport is here: the route answers HTTP, the handler publishes an event. GitHub's own failures
 * are thrown (issue-clients.ts).
 */
import type { IssueTracker, NewIssue } from "./issue-clients";
import { existingLabels, linksToApp } from "./issue-draft";
import { APP_DOMAIN } from "./issue-drafting";

export interface IssueRequest extends NewIssue {
  repo: string;
  /** The person saw that the repo is public and still wants the issue there. */
  acknowledgedPublic: boolean;
}

export type CreateResult =
  | { ok: true; issue: { url: string; number: number }; labels: string[] }
  | { ok: false; error: "public_not_acknowledged"; repo: string; message: string }
  | { ok: false; error: "invalid_issue"; message: string };

export async function createIssue(
  tracker: IssueTracker,
  req: IssueRequest,
  opts: {
    /** "drop": keep only the labels the repo has (the preview's free edit); "refuse": any other is invalid_issue. */
    unknownLabels: "drop" | "refuse";
    /** How the issue is created once every check passed; by default `tracker.create`. */
    create?: (repo: string, issue: NewIssue) => Promise<{ url: string; number: number }>;
  },
): Promise<CreateResult> {
  const { repo, title, body } = req;
  if (linksToApp(title, APP_DOMAIN) || linksToApp(body, APP_DOMAIN)) {
    return {
      ok: false,
      error: "invalid_issue",
      message: `Links to ${APP_DOMAIN} can't be opened by anyone else: name the document's path instead.`,
    };
  }
  if ((await tracker.repo(repo)).public && !req.acknowledgedPublic) {
    return {
      ok: false,
      error: "public_not_acknowledged",
      repo,
      message: `${repo} is public: everything in this issue will be visible to everyone. Check it, then create again.`,
    };
  }
  const available = await tracker.labels(repo);
  const labels = existingLabels(req.labels, available);
  if (opts.unknownLabels === "refuse") {
    const known = new Set(available.map((l) => l.toLowerCase()));
    const unknown = req.labels.filter((l) => !known.has(l.trim().toLowerCase()));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: "invalid_issue",
        message: `${repo} has no label ${unknown.map((l) => `"${l}"`).join(", ")}.`.slice(0, 1000),
      };
    }
  }
  const issue = await (opts.create ?? ((r, i) => tracker.create(r, i)))(repo, { title, body, labels });
  return { ok: true, issue, labels };
}
