/**
 * POST /api/notes/:id/issue, for docs.issues.create on the caller's own note (#82): creates the issue
 * the owner kept or edited in the preview, and saves its URL on the note. A note that already has an
 * issue answers 409 unless the owner confirmed a second one (`confirm: true`).
 */
import { APP_DOMAIN, invalidIssue, issueAccess, issueTracker, logIssue, serviceFailure } from "@/lib/issue-api";
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

  try {
    const labels = existingLabels(input.data.labels, await github.tracker.labels(repo));
    const issue = await github.tracker.create(repo, { title, body: input.data.body, labels });
    const note = await a.store.setIssueUrl(a.subject, a.note.id, issue.url);
    logIssue("issue.created", { note: a.note.id, issue: issue.number, labels: labels.length, again: confirm });
    return json({ note, issue }, 201);
  } catch (err) {
    return serviceFailure(err);
  }
}
