import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { at, until } from "@/lib/format";
import { pageAccess } from "@/lib/page";
import { listPendingApprovals } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Approvals waiting for a decision, oldest first (flow.approvals.decide). */
export default async function Approvals({
  searchParams,
}: {
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
  const { error, permission } = await searchParams;
  const now = new Date();
  const pending = await listPendingApprovals(await db(), now);
  return (
    <Shell current="/approvals">
      <h1>
        Approvals <span className="count">{pending.length}</span>
      </h1>
      <ErrorNotice error={error} permission={permission} />
      <section className="card" aria-labelledby="pending">
        <h2 id="pending">Waiting for a decision</h2>
        {pending.length ? (
          <div className="table-wrap">
            <table data-testid="approvals">
              <thead>
                <tr>
                  <th scope="col">Approval</th>
                  <th scope="col">Run</th>
                  <th scope="col">Document</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Deadline</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((a) => (
                  <tr key={a.id} data-testid="approval">
                    <td>
                      <a href={`/approvals/${a.id}`}>Review</a>
                    </td>
                    <td>
                      <a href={`/runs/${a.runId}`} className="mono">
                        {a.runId.slice(-8)}
                      </a>{" "}
                      <span className="muted">{a.workflowKey}</span>
                    </td>
                    <td className="mono">{a.docPath ?? "–"}</td>
                    <td className="mono">{a.repo ?? "–"}</td>
                    <td>{at(a.createdAt)}</td>
                    <td title={at(a.deadline)}>{until(a.deadline, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" data-testid="approvals-empty">
            Nothing is waiting for a decision.
          </p>
        )}
      </section>
    </Shell>
  );
}
