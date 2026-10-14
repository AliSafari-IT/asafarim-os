/**
 * POST /api/notes/:id/issue/draft, for docs.issues.create on the caller's own note (#82): the AI
 * drafts a GitHub issue from the note for the repo that owns its document (or the `repo` sent).
 * A preview only: nothing is created on GitHub. The body is JSON (`{}` or `{ "repo": "owner/name" }`).
 */
import {
  APP_DOMAIN,
  invalidIssue,
  issueAccess,
  issueTracker,
  issueWriter,
  logIssue,
  noteDocument,
  serviceFailure,
} from "@/lib/issue-api";
import { buildIssueContext } from "@/lib/issue-context";
import { DraftRequest, existingLabels, IssueDraft, issuePrompt, withoutAppLinks } from "@/lib/issue-draft";
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
    const [target, labels] = await Promise.all([github.tracker.repo(repo), github.tracker.labels(repo)]);
    const context = buildIssueContext({ docPath: a.note.docPath, markdown: doc.markdown, note: a.note, repo, labels });
    const { answer, usage } = await ai.writer.draft(issuePrompt(context, target.public));
    const parsed = IssueDraft.safeParse(answer);
    logIssue("issue.draft", {
      note: a.note.id,
      public: target.public,
      words: context.words,
      valid: parsed.success,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    if (!parsed.success) {
      return json({ error: "invalid_ai_answer", message: "The AI's answer wasn't a usable issue. Try again." }, 502);
    }
    const draft = withoutAppLinks(
      { ...parsed.data, labels: existingLabels(parsed.data.labels, labels) },
      APP_DOMAIN,
      a.note.docPath,
    );
    return json({ repo, public: target.public, draft, labels, issueUrl: a.note.issueUrl });
  } catch (err) {
    return serviceFailure(err);
  }
}
