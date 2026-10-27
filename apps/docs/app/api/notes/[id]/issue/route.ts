/**
 * POST /api/notes/:id/issue, for docs.issues.create on the caller's own note (#82): creates the issue
 * the owner kept or edited in the preview, and saves its URL on the note. A note that already has an
 * issue answers 409 unless the owner confirmed a second one (`confirm: true`). Once GitHub has created
 * the issue, a URL that can't be saved (500 `issue_url_not_saved`) or a note deleted meanwhile (410
 * `note_gone`) still answers with the issue, so nobody retries into a duplicate. A public repo needs
 * `acknowledgedPublic: true` (the preview showed its banner); without it the answer is 409
 * `public_not_acknowledged` and nothing is created, whatever the client shows.
 */
import { invalidIssue, issueAccess, issueTracker, logIssue, saveIssueUrl, serviceFailure } from "@/lib/issue-api";
import { createIssue } from "@/lib/issue-create";
import { CreateRequest } from "@/lib/issue-draft";
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
  const { repo, confirm } = input.data;
  if (a.note.issueUrl && !confirm) {
    return json(
      { error: "issue_exists", issueUrl: a.note.issueUrl, message: "This note already has an issue. Create another?" },
      409,
    );
  }
  const github = issueTracker();
  if (!github.ok) return github.res;

  let created;
  try {
    // The preview only offers the repo's labels; any other is dropped, not refused.
    created = await createIssue(github.tracker, input.data, { unknownLabels: "drop" });
  } catch (err) {
    return serviceFailure(err);
  }
  if (!created.ok) {
    if (created.error === "invalid_issue") return invalidIssue(created.message);
    return json({ error: created.error, repo, public: true, message: created.message }, 409);
  }
  const { issue, labels } = created;
  logIssue("issue.created", { note: a.note.id, issue: issue.number, labels: labels.length, again: confirm });
  // The issue exists now: a failure from here on answers with it, never as a retryable error.
  const saved = await saveIssueUrl(a.store, a.subject, a.note.id, issue);
  if (!saved.ok) return saved.res;
  return json({ note: saved.note, issue }, 201);
}
