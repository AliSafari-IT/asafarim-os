import { runNowAction, setWorkflowStatusAction } from "@/app/actions";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Status } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { at } from "@/lib/format";
import { pageAccess } from "@/lib/page";
import { listWorkflows } from "@/lib/queries";
import { triggerOf } from "@/lib/workflow/definition";
import type { TriggerV2 } from "@/lib/workflow/definition-v2";
import { fieldName, typeFieldName } from "@/lib/workflow/manual";

export const dynamic = "force-dynamic";

/** What starts a workflow, in a few words. */
function TriggerText({ trigger }: { trigger: TriggerV2 }) {
  switch (trigger.type) {
    case "event":
      return (
        <>
          triggered by <span className="mono">{trigger.event}</span>
        </>
      );
    case "manual":
      return <>run by hand</>;
    case "webhook":
      return <>triggered by a webhook</>;
    case "github":
      return (
        <>
          triggered by GitHub (<span className="mono">{trigger.repo}</span>)
        </>
      );
  }
}

/** "Run now": one field per input field of the manual trigger. */
function RunNow({ workflow, trigger }: { workflow: string; trigger: Extract<TriggerV2, { type: "manual" }> }) {
  return (
    <form action={runNowAction} className="card" data-testid="run-now">
      <input type="hidden" name="workflow" value={workflow} />
      {trigger.input.map((f) => {
        const id = `${workflow}-${f.name}`;
        const label = `${f.label ?? f.name}${f.required ? " (required)" : ""}`;
        return (
          <p key={f.name} className={f.type === "boolean" ? "check" : undefined}>
            <input type="hidden" name={typeFieldName(f.name)} value={f.type} />
            {f.type === "boolean" ? (
              <>
                <input type="checkbox" id={id} name={fieldName(f.name)} />
                <label htmlFor={id}>{label}</label>
              </>
            ) : (
              <>
                <label htmlFor={id}>{label}</label>
                <input
                  id={id}
                  name={fieldName(f.name)}
                  type={f.type === "number" ? "number" : "text"}
                  step={f.type === "number" ? "any" : undefined}
                  required={f.required}
                />
              </>
            )}
          </p>
        );
      })}
      <div className="actions">
        <button type="submit" data-testid="run-now-submit">
          Run now
        </button>
      </div>
    </form>
  );
}

/**
 * The workflows and their current definition, read-only; Pause and Resume for flow.workflows.write;
 * "Run now" for a manual trigger, with flow.runs.start.
 */
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
  const canStart = access.permissions.includes("flow.runs.start");
  return (
    <Shell current="/workflows">
      <h1>Workflows</h1>
      <ErrorNotice error={error} permission={permission} />
      {workflows.map((w) => {
        const trigger = triggerOf(w.current.definition);
        return (
          <section key={w.key} className="card" data-testid="workflow" data-workflow={w.key}>
            <h2>
              {w.name} <Status value={w.status} />
            </h2>
            <p className="muted">
              <span className="mono">{w.key}</span> · version {w.current.version} of {w.versions} · published{" "}
              {at(w.current.publishedAt)} · <TriggerText trigger={trigger} />
              {w.draftUpdatedAt ? <> · a draft saved {at(w.draftUpdatedAt)}</> : null}
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
            {canStart && trigger.type === "manual" && w.status === "active" ? (
              <RunNow workflow={w.key} trigger={trigger} />
            ) : null}
            <details open>
              <summary>Definition (read-only)</summary>
              <pre data-testid="definition">{JSON.stringify(w.current.definition, null, 2)}</pre>
            </details>
          </section>
        );
      })}
    </Shell>
  );
}
