/**
 * The issue a note becomes (#82): what the AI must answer (validated, never trusted), the prompt that
 * asks for it, and what "Create issue" may send. Pure: no I/O.
 */
import { z } from "zod";
import { contextText, type IssueContext } from "./issue-context";

/** The four sections every drafted issue body has, in this order. */
export const ISSUE_SECTIONS = ["Context", "Problem / request", "Suggested steps", "Done when"] as const;

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export const Repo = z.string().regex(REPO, "must be owner/name");

const Title = z.string().trim().min(1).max(200);
const Body = z.string().trim().min(1).max(20_000);
const Labels = z.array(z.string().trim().min(1).max(50)).max(10);

/** The AI's answer. A body without the four sections is a bad answer, not an issue. */
export const IssueDraft = z.object({
  title: Title,
  body: Body.refine(
    (body) => ISSUE_SECTIONS.every((s) => new RegExp(`^#{2,3}\\s+${escapeRe(s)}\\s*$`, "mi").test(body)),
    { message: `the body needs the sections ${ISSUE_SECTIONS.join(", ")}` },
  ),
  labels: Labels.default([]),
});
export type IssueDraft = z.output<typeof IssueDraft>;

/** POST /api/notes/:id/issue/draft: optionally another target repo ("Regenerate" for it). */
export const DraftRequest = z.object({ repo: Repo.optional() });

/** POST /api/notes/:id/issue: what the owner kept or edited in the preview. */
export const CreateRequest = z.object({
  repo: Repo,
  title: Title,
  body: Body,
  labels: Labels.default([]),
  /** The note already has an issue and the owner confirmed a second one. */
  confirm: z.boolean().default(false),
});

function escapeRe(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Only labels the repo has, each once, matched without regard to case and spelled as the repo spells it. */
export function existingLabels(wanted: string[], available: string[]): string[] {
  const byKey = new Map(available.map((l) => [l.toLowerCase(), l]));
  const out: string[] = [];
  for (const w of wanted) {
    const hit = byKey.get(w.trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** A link to the reader itself (`docs.asafarim.site`): nobody else can open it. */
export function appLinkPattern(domain: string): RegExp {
  return new RegExp(`(?:https?:)?//${escapeRe(domain)}(?::\\d+)?(?:[/?#][^\\s)\\]>"']*)?`, "gi");
}

export const linksToApp = (text: string, domain: string) => appLinkPattern(domain).test(text);

/** A draft with every link to the reader replaced by the document's path. */
export function withoutAppLinks(draft: IssueDraft, domain: string, docPath: string): IssueDraft {
  const re = appLinkPattern(domain);
  return { ...draft, title: draft.title.replace(re, docPath), body: draft.body.replace(re, docPath) };
}

/** The structured answer the AI gives: one forced tool call with this input schema. */
export const ISSUE_TOOL = {
  name: "issue_draft",
  description: "Return the drafted GitHub issue.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short, specific issue title (max 200 characters)." },
      body: {
        type: "string",
        description: `Markdown with exactly these level-2 sections, in order: ${ISSUE_SECTIONS.map((s) => `"## ${s}"`).join(", ")}.`,
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Zero to three labels, chosen ONLY from the repository's existing labels.",
      },
    },
    required: ["title", "body", "labels"],
    additionalProperties: false,
  },
} as const;

export function issuePrompt(context: IssueContext, publicRepo: boolean): { system: string; user: string } {
  const system = [
    "You turn a documentation owner's study note into a GitHub issue that a junior developer can understand and act on.",
    `Write the body in Markdown with exactly these sections: ${ISSUE_SECTIONS.map((s) => `"## ${s}"`).join(", ")}.`,
    "Context: what the document says and why it matters, in your own words. Problem / request: what the note asks for. Suggested steps: a short numbered list. Done when: a checklist of observable results.",
    "Rules:",
    "- Never include secrets, tokens, passwords, e-mail addresses or other personal data.",
    "- Never include prices, revenue, customers or other commercial plans.",
    "- Do not paste long passages of the document. Summarise only what a developer needs; quote at most one short sentence.",
    "- Never link to the documentation reader; you may name the document's path.",
    "- You may reference the related issues you are given.",
    "- Only use labels from the given list of existing labels; use none if none fits.",
    publicRepo
      ? "- The target repository is PUBLIC: everything you write will be visible to everyone. Be especially careful."
      : "- The target repository is private.",
    "Answer only by calling the issue_draft tool.",
  ].join("\n");
  return { system, user: contextText(context) };
}
