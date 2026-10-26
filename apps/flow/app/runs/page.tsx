import { RunTable } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { Unavailable } from "@/components/Notice";
import { db } from "@/lib/db";
import { pageAccess } from "@/lib/page";
import { listRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Runs, newest first. Skipped runs (a condition said no) are hidden unless asked for. */
export default async function Runs({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const access = await pageAccess();
  if (!access.ok) {
    return (
      <Shell current="/runs">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const skipped = (await searchParams).skipped === "1";
  const runs = await listRuns(await db(), { skipped });
  return (
    <Shell current="/runs">
      <h1>Runs</h1>
      <form className="filters" method="get">
        <label className="check">
          <input type="checkbox" name="skipped" value="1" defaultChecked={skipped} data-testid="show-skipped" />
          Show skipped runs
        </label>
        <button type="submit" className="secondary">
          Apply
        </button>
      </form>
      <section className="card">
        <RunTable
          runs={runs}
          empty={skipped ? "No runs yet." : "No runs yet (skipped ones are hidden)."}
          testId="runs"
        />
      </section>
    </Shell>
  );
}
