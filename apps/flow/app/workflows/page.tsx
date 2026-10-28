import { duplicateWorkflowAction, runNowAction, setWorkflowStatusAction } from "@/app/actions";
import { HookSection } from "@/components/HookPanel";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Status } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { at } from "@/lib/format";
import { listHooks, type HookSummary } from "@/lib/hooks/store";
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
          triggered by GitHub (<span className="mono">{trigger.repos.join(", ")}</span>)
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

/** Duplicate: the new workflow's name and key; the builder opens on its draft. */
function DuplicateForm({ workflow, name }: { workflow: string; name: string }) {
  return (
    <details className="duplicate">
      <summary>Duplicate</summary>
      <form action={duplicateWorkflowAction} className="inline-form" data-testid="duplicate">
        <input type="hidden" name="workflow" value={workflow} />
        <label htmlFor={`${workflow}-dup-name`}>Name</label>
        <input id={`${workflow}-dup-name`} name="name" defaultValue={`${name} (copy)`} required maxLength={200} />
        <label htmlFor={`${workflow}-dup-key`}>Key</label>
        <input
          id={`${workflow}-dup-key`}
          name="key"
          defaultValue={`${workflow}-copy`.slice(0, 64)}
          required
          maxLength={64}
          pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
          aria-describedby={`${workflow}-dup-hint`}
        />
        <p id={`${workflow}-dup-hint`} className="muted hint">
          Lower case letters, digits and dashes; it can&apos;t be changed later. A webhook or GitHub trigger needs a
          hook of its own: the copy&apos;s is left empty.
        </p>
        <button type="submit">Duplicate</button>
      </form>
    </details>
  );
}

/**
 * The workflows and their current definition, read-only; Pause and Resume for flow.workflows.write;
 * "Run now" for a manual trigger, with flow.runs.start; a webhook or GitHub trigger's hook, New workflow,
 * Edit (the builder) and Duplicate with flow.workflows.write; View in the builder, read-only, otherwise.
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
  const pool = await db();
  const workflows = await listWorkflows(pool);
  const canWrite = access.permissions.includes("flow.workflows.write");
  const hooks = canWrite
    ? new Map((await listHooks(pool)).map((h) => [h.workflowKey, h]))
    : new Map<string, HookSummary>();
  const canStart = access.permissions.includes("flow.runs.start");
  return (
    <Shell current="/workflows">
      <div className="page-head">
        <h1>Workflows</h1>
        {canWrite ? (
          <a className="button" href="/workflows/new" data-testid="new-workflow">
            New workflow
          </a>
        ) : null}
      </div>
      <ErrorNotice error={error} permission={permission} />
      {workflows.map((w) => {
        const trigger = w.current ? triggerOf(w.current.definition) : undefined;
        return (
          <section key={w.key} className="card" data-testid="workflow" data-workflow={w.key}>
            <h2>
              {w.name} <Status value={w.status} />
            </h2>
            <p className="muted">
              <span className="mono">{w.key}</span> ·{" "}
              {w.current ? (
                <>
                  version {w.current.version} of {w.versions} · published {at(w.current.publishedAt)}
                </>
              ) : (
                <>not published yet</>
              )}
              {trigger ? (
                <>
                  {" "}
                  · <TriggerText trigger={trigger} />
                </>
              ) : null}
              {w.draftUpdatedAt ? <> · a draft saved {at(w.draftUpdatedAt)}</> : null}
            </p>
            <div className="actions">
              <a className="button" href={`/workflows/${w.key}/edit`} data-testid="edit">
                {canWrite ? "Edit" : "View"}
              </a>
              {w.versions ? (
                <a className="button secondary" href={`/workflows/${w.key}/versions`}>
                  Versions
                </a>
              ) : null}
              {canWrite && w.current ? (
                <form action={setWorkflowStatusAction}>
                  <input type="hidden" name="workflow" value={w.key} />
                  <input type="hidden" name="status" value={w.status === "active" ? "paused" : "active"} />
                  <button type="submit" className="secondary" data-testid="toggle">
                    {w.status === "active" ? "Pause" : "Resume"}
                  </button>
                </form>
              ) : null}
            </div>
            {canWrite ? <DuplicateForm workflow={w.key} name={w.name} /> : null}
            {canWrite && trigger && (trigger.type === "webhook" || trigger.type === "github" || hooks.has(w.key)) ? (
              <HookSection workflow={w.key} trigger={trigger} hook={hooks.get(w.key)} />
            ) : null}
            {canStart && trigger?.type === "manual" && w.status === "active" ? (
              <RunNow workflow={w.key} trigger={trigger} />
            ) : null}
            {w.current ? (
              <details open>
                <summary>Definition (read-only)</summary>
                <pre data-testid="definition">{JSON.stringify(w.current.definition, null, 2)}</pre>
              </details>
            ) : null}
          </section>
        );
      })}
    </Shell>
  );
}
