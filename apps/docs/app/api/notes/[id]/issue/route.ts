/**
 * POST /api/notes/:id/issue, for docs.issues.create on the caller's own note (#82): creates the issue
 * the owner kept or edited in the preview, and saves its URL on the note. A note that already has an
 * issue answers 409 unless the owner confirmed a second one (`confirm: true`). Once GitHub has created
 * the issue, a URL that can't be saved (500 `issue_url_not_saved`) or a note deleted meanwhile (410
 * `note_gone`) still answers with the issue, so nobody retries into a duplicate.
 */
import {
  APP_DOMAIN,
  invalidIssue,
  issueAccess,
  issueTracker,
  logIssue,
  saveIssueUrl,
  serviceFailure,
} from "@/lib/issue-api";
import { CreateRequest, existingLabels, linksToApp } from "@/lib/issue-draft";
import { json, jsonBody } from "@/lib/notes-api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const a = await issueAccess((await params).id);
  if (!a.ok) return a.res;
  const body = await jsonBody(request);
  if (!body.ok) return body.res;
  const input = CreateRequest.safeParse(body.body);
  if (!input.success) {
    return invalidIssue("An issue needs a repository (owner/name), a title (1–200) and a body (1–20 000).");
  }
  const { repo, title, confirm } = input.data;
  if (a.note.issueUrl && !confirm) {
    return json(
      { error: "issue_exists", issueUrl: a.note.issueUrl, message: "This note already has an issue. Create another?" },
      409,
    );
  }
  if (linksToApp(title, APP_DOMAIN) || linksToApp(input.data.body, APP_DOMAIN)) {
    return invalidIssue(`Links to ${APP_DOMAIN} can't be opened by anyone else: name the document's path instead.`);
  }
  const github = issueTracker();
  if (!github.ok) return github.res;

  let labels: string[];
  let issue: { url: string; number: number };
  try {
    labels = existingLabels(input.data.labels, await github.tracker.labels(repo));
    issue = await github.tracker.create(repo, { title, body: input.data.body, labels });
  } catch (err) {
    return serviceFailure(err);
  }
  logIssue("issue.created", { note: a.note.id, issue: issue.number, labels: labels.length, again: confirm });
  // The issue exists now: a failure from here on answers with it, never as a retryable error.
  const saved = await saveIssueUrl(a.store, a.subject, a.note.id, issue);
  if (!saved.ok) return saved.res;
  return json({ note: saved.note, issue }, 201);
}
