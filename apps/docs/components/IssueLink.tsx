"use client";
import { useMessages } from "./I18n";
import { issueHref } from "@/lib/issue-link";

/**
 * A note's GitHub issue (#82): its link, and "via Flow" when Flow created it from an approved draft
 * (ADR 0001). Nothing for a URL that isn't a GitHub issue's own. Used by the reader and by /notes.
 */
export function IssueLink({ url, viaFlow }: { url: string | null; viaFlow: boolean }) {
  const m = useMessages();
  const href = issueHref(url);
  if (!href) return null;
  return (
    <>
      <a className="issue-link" href={href} target="_blank" rel="noopener noreferrer" data-testid="issue-link">
        {m.issueCreated}
      </a>
      {viaFlow ? (
        <span className="via-flow" data-testid="via-flow" title="Created by Flow from a draft you approved">
          {m.viaFlow}
        </span>
      ) : null}
    </>
  );
}
