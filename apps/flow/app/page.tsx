import { RunTable } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { Unavailable } from "@/components/Notice";
import { db } from "@/lib/db";
import { pageAccess } from "@/lib/page";
import { overview } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Overview: what waits for your approval, what waits, what failed in the last 7 days, and the last 10 runs. */
export default async function Overview() {
  const access = await pageAccess();
  if (!access.ok) {
    return (
      <Shell current="/">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const o = await overview(await db());
  const canDecide = access.permissions.includes("flow.approvals.decide");
  return (
    <Shell current="/">
      <h1>Overview</h1>
      {canDecide ? (
        <section className="card" aria-labelledby="your-approval">
          <h2 id="your-approval">
            Waiting for your approval{" "}
            <span className="count" data-testid="pending-approvals">
              {o.pendingApprovals}
            </span>
          </h2>
          {o.pendingApprovals ? (
            <a href="/approvals">Review them on Approvals</a>
          ) : (
            <p className="muted">Nothing to decide.</p>
          )}
        </section>
      ) : null}
      <section className="card" aria-labelledby="waiting">
        <h2 id="waiting">
          Waiting <span className="count">{o.waiting.length}</span>
        </h2>
        <RunTable runs={o.waiting} empty="Nothing is waiting." testId="waiting" />
      </section>
      <section className="card" aria-labelledby="failures">
        <h2 id="failures">
          Failed in the last 7 days <span className="count">{o.failures.length}</span>
        </h2>
        <RunTable runs={o.failures} empty="No failures." testId="failures" />
      </section>
      <section className="card" aria-labelledby="latest">
        <h2 id="latest">Last 10 runs</h2>
        <RunTable runs={o.latest} empty="No runs yet." testId="latest" />
      </section>
    </Shell>
  );
}
