import { setWorkflowStatusAction } from "@/app/actions";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Status } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { at } from "@/lib/format";
import { pageAccess } from "@/lib/page";
import { listWorkflows } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** The workflows and their current definition, read-only; Pause and Resume for flow.workflows.write. */
export default async function Workflows({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess();
  if (!access.ok) {
    return (
      <Shell current="/workflows">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { error, permission } = await searchParams;
  const workflows = await listWorkflows(await db());
  const canWrite = access.permissions.includes("flow.workflows.write");
  return (
    <Shell current="/workflows">
      <h1>Workflows</h1>
      <ErrorNotice error={error} permission={permission} />
      {workflows.map((w) => (
        <section key={w.key} className="card" data-testid="workflow" data-workflow={w.key}>
          <h2>
            {w.name} <Status value={w.status} />
          </h2>
          <p className="muted">
            <span className="mono">{w.key}</span> · version {w.current.version} of {w.versions} · published{" "}
            {at(w.current.publishedAt)} · triggered by{" "}
            <span className="mono">{w.current.definition.trigger.event}</span>
          </p>
          {canWrite ? (
            <form action={setWorkflowStatusAction}>
              <input type="hidden" name="workflow" value={w.key} />
              <input type="hidden" name="status" value={w.status === "active" ? "paused" : "active"} />
              <button type="submit" className="secondary" data-testid="toggle">
                {w.status === "active" ? "Pause" : "Resume"}
              </button>
            </form>
          ) : null}
          <details open>
            <summary>Definition (read-only)</summary>
            <pre data-testid="definition">{JSON.stringify(w.current.definition, null, 2)}</pre>
          </details>
        </section>
      ))}
    </Shell>
  );
}
