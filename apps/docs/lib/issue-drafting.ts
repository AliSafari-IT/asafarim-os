import "server-only";
/**
 * Drafting a GitHub issue from a note (#82), shared by the HTTP route (POST /api/notes/:id/issue/draft)
 * and Flow's request (lib/issue-draft-handler.ts): the note's document and the repo that owns it, the
 * context, the AI's answer validated, labels limited to the repo's own and links to the reader
 * replaced. Nothing is created on GitHub. Neither caller's transport is here: the route answers HTTP,
 * the handler publishes an event. No event SDK either (pages import this through the route).
 */
import manifest from "../platform.app";
import { buildIssueContext } from "./issue-context";
import type { IssueTracker, IssueWriter } from "./issue-clients";
import { existingLabels, IssueDraft, issuePrompt, withoutAppLinks } from "./issue-draft";
import type { Note } from "./notes";
import { ownerOf } from "./owners";
import { getPlatform } from "./platform";
import { getSource } from "./source";

/** The reader's own domain: links to it are useless in an issue (nobody else can open them). */
export const APP_DOMAIN = manifest.domains?.primary ?? "docs.asafarim.site";

/**
 * The note's document and the repo that owns it (front matter, docs-app.json, else the source repo).
 * Throws the source's `DocNotFoundError` or `SourceUnavailableError`.
 */
export async function loadNoteDocument(docPath: string): Promise<{ markdown: string; ownerRepo: string }> {
  const config = getPlatform().config;
  const sourceRepo = config.getString("source.repo");
  const source = getSource({ repo: sourceRepo, branch: config.getString("source.branch") });
  const [listing, markdown] = await Promise.all([source.listDocs(), source.readDoc(docPath)]);
  const owners = listing.owners?.ok ? listing.owners.config : undefined;
  return { markdown, ownerRepo: ownerOf(docPath, { config: owners, markdown, fallbackRepo: sourceRepo }).repo };
}

export type DraftResult =
  | { ok: true; repo: string; public: boolean; draft: IssueDraft; labels: string[] }
  | { ok: false; error: "invalid_ai_answer" };

/**
 * Draft the issue for `repo`: its visibility and labels from GitHub, then the AI. An answer that fails
 * validation is `invalid_ai_answer`; GitHub's and the AI's own failures are thrown (issue-clients.ts).
 * `labels` is everything the repo has; the draft keeps only those of its labels the repo has.
 */
export async function draftIssue(input: {
  note: Pick<Note, "id" | "docPath" | "headingId" | "quote" | "body">;
  markdown: string;
  repo: string;
  tracker: IssueTracker;
  writer: IssueWriter;
}): Promise<DraftResult> {
  const { note, markdown, repo } = input;
  const [target, labels] = await Promise.all([input.tracker.repo(repo), input.tracker.labels(repo)]);
  const context = buildIssueContext({ docPath: note.docPath, markdown, note, repo, labels });
  const { answer, usage } = await input.writer.draft(issuePrompt(context, target.public));
  const parsed = IssueDraft.safeParse(answer);
  logIssue("issue.draft", {
    note: note.id,
    public: target.public,
    words: context.words,
    valid: parsed.success,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  if (!parsed.success) return { ok: false, error: "invalid_ai_answer" };
  const draft = withoutAppLinks(
    { ...parsed.data, labels: existingLabels(parsed.data.labels, labels) },
    APP_DOMAIN,
    note.docPath,
  );
  return { ok: true, repo, public: target.public, draft, labels };
}

/** One log line: ids, counts and token usage only. */
export function logIssue(
  msg: string,
  fields: Record<string, string | number | boolean>,
  level: "info" | "warn" = "info",
) {
  const line = JSON.stringify({ app: "docs", level, msg, ...fields });
  if (level === "warn") console.warn(line);
  else console.info(line);
}
