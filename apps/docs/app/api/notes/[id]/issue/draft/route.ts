/**
 * POST /api/notes/:id/issue/draft, for docs.issues.create on the caller's own note (#82): the AI
 * drafts a GitHub issue from the note for the repo that owns its document (or the `repo` sent).
 * A preview only: nothing is created on GitHub. The body is JSON (`{}` or `{ "repo": "owner/name" }`).
 */
import { invalidIssue, issueAccess, issueTracker, issueWriter, noteDocument, serviceFailure } from "@/lib/issue-api";
import { DraftRequest } from "@/lib/issue-draft";
import { draftIssue } from "@/lib/issue-drafting";
import { json, jsonBody } from "@/lib/notes-api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const a = await issueAccess((await params).id);
  if (!a.ok) return a.res;
  const body = await jsonBody(request);
  if (!body.ok) return body.res;
  const input = DraftRequest.safeParse(body.body);
  if (!input.success) return invalidIssue("The target repository must be owner/name.");
  const github = issueTracker();
  if (!github.ok) return github.res;
  const ai = issueWriter();
  if (!ai.ok) return ai.res;
  const doc = await noteDocument(a.note.docPath);
  if (!doc.ok) return doc.res;
  const repo = input.data.repo ?? doc.ownerRepo;

  try {
    const d = await draftIssue({
      note: a.note,
      markdown: doc.markdown,
      repo,
      tracker: github.tracker,
      writer: ai.writer,
    });
    if (!d.ok) {
      return json({ error: "invalid_ai_answer", message: "The AI's answer wasn't a usable issue. Try again." }, 502);
    }
    return json({ repo, public: d.public, draft: d.draft, labels: d.labels, issueUrl: a.note.issueUrl });
  } catch (err) {
    return serviceFailure(err);
  }
}
