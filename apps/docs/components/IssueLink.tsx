import { issueHref } from "@/lib/issue-link";

/**
 * A note's GitHub issue (#82): its link, and "via Flow" when Flow created it from an approved draft
 * (ADR 0001). Nothing for a URL that isn't a GitHub issue's own. Used by the reader and by /notes.
 */
export function IssueLink({ url, viaFlow }: { url: string | null; viaFlow: boolean }) {
  const href = issueHref(url);
  if (!href) return null;
  return (
    <>
      <a className="issue-link" href={href} target="_blank" rel="noopener noreferrer" data-testid="issue-link">
        Issue created ✓
      </a>
      {viaFlow ? (
        <span className="via-flow" data-testid="via-flow" title="Created by Flow from a draft you approved">
          via Flow
        </span>
      ) : null}
    </>
  );
}
