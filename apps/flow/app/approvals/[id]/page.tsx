import { notFound } from "next/navigation";
import { approveAction, rejectAction } from "@/app/actions";
import { DraftForm } from "@/components/DraftForm";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Status } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { docsLink } from "@/lib/docs-link";
import { APPROVAL_ID, at, until } from "@/lib/format";
import { pageAccess } from "@/lib/page";
import { COMMENT_MAX } from "@/lib/workflow/limits";
import { getApproval } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * One approval (flow.approvals.decide): the repository (public or not), the draft to edit with its
 * preview, the document in Docs, and Approve or Reject. Once decided, what was decided.
 */
export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess("flow.approvals.decide");
  if (!access.ok) {
    return (
      <Shell current="/approvals">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { id } = await params;
  const { error, permission } = await searchParams;
  const found = APPROVAL_ID.test(id) ? await getApproval(await db(), id) : undefined;
  if (!found) notFound();
  const { approval, run, step, draft } = found;
  const now = new Date();
  const open = approval.status === "pending" && run.status === "waiting" && (approval.deadline ?? now) > now;
  const link = draft ? docsLink(draft.docPath) : undefined;

  return (
    <Shell current="/approvals">
      <p className="muted">
        <a href="/approvals">Approvals</a> / <span className="mono">{approval.id}</span>
      </p>
      <h1>
        {step.reviews === "draft" ? "Review the issue" : "Approve the run"} <Status value={approval.status} />
      </h1>
      <ErrorNotice error={error} permission={permission} />
      {draft?.public ? (
        <div className="notice warn" role="note" data-testid="public">
          <strong>This repository is public.</strong> Once approved, the issue is visible to anyone.
        </div>
      ) : null}
      <dl className="facts card">
        <dt>Repository</dt>
        <dd className="mono" data-testid="repo">
          {draft?.repo ?? "–"} {draft ? <span className="muted">({draft.public ? "public" : "private"})</span> : null}
        </dd>
        <dt>Document</dt>
        <dd>
          <span className="mono">{draft?.docPath ?? "–"}</span>
          {link ? (
            <>
              {" · "}
              <a href={link} target="_blank" rel="noopener noreferrer" data-testid="docs-link">
                Open the document in Docs
              </a>
            </>
          ) : null}
        </dd>
        <dt>Run</dt>
        <dd>
          <a href={`/runs/${run.id}`} className="mono">
            {run.id}
          </a>{" "}
          <Status value={run.status} />
        </dd>
        {step.reviews === "nothing" ? (
          <>
            <dt>Payload</dt>
            <dd>
              {/* What started the run: a plain decision is about it. Shown as data, never rendered. */}
              <pre data-testid="payload">{JSON.stringify(run.trigger, null, 2)}</pre>
            </dd>
          </>
        ) : null}
        <dt>For</dt>
        <dd>
          the role <span className="perm">{step.role}</span>
        </dd>
        <dt>Deadline</dt>
        <dd>
          {at(approval.deadline)} {approval.status === "pending" ? `(${until(approval.deadline, now)})` : null}
        </dd>
        {approval.decidedAt ? (
          <>
            <dt>Decided</dt>
            <dd data-testid="decided">
              {approval.status} by <span className="mono">{approval.decidedBy}</span> at {at(approval.decidedAt)}
            </dd>
          </>
        ) : null}
        {approval.edited ? (
          <>
            <dt>Edited</dt>
            <dd>{Object.keys(approval.edited).join(", ")}</dd>
          </>
        ) : null}
        {approval.comment ? (
          <>
            <dt>Comment</dt>
            <dd className="pre-wrap">{approval.comment}</dd>
          </>
        ) : null}
      </dl>

      {step.reviews === "nothing" ? (
        open ? (
          <div className="decide">
            <form action={approveAction} className="card">
              <input type="hidden" name="approvalId" value={approval.id} />
              <div className="actions">
                <button type="submit" data-testid="approve">
                  Approve
                </button>
              </div>
            </form>
            <form action={rejectAction} className="card">
              <input type="hidden" name="approvalId" value={approval.id} />
              <label htmlFor="comment">Comment (optional)</label>
              <textarea id="comment" name="comment" maxLength={COMMENT_MAX} rows={3} />
              <div className="actions">
                <button type="submit" className="secondary" data-testid="reject">
                  Reject
                </button>
              </div>
            </form>
          </div>
        ) : (
          <p className="notice" role="status" data-testid="closed">
            This approval is {approval.status}; nothing is left to decide.
          </p>
        )
      ) : !draft ? (
        <p className="notice" role="status">
          The draft is no longer kept (it is cleared 30 days after the run ended).
        </p>
      ) : open ? (
        <DraftForm approvalId={approval.id} draft={draft} editable={step.editable} />
      ) : (
        <p className="notice" role="status" data-testid="closed">
          This approval is {approval.status}; nothing is left to decide.
        </p>
      )}
    </Shell>
  );
}
