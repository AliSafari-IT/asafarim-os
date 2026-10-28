import { deleteHookAction, runNowAction, setWorkflowStatusAction } from "@/app/actions";
import { CreateHookForm, RegenerateHookForm, type HookTarget } from "@/components/HookForms";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Status } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { at } from "@/lib/format";
import { curlExample, hookUrl, sampleBody } from "@/lib/hooks/example";
import { listHooks, type HookSummary } from "@/lib/hooks/store";
import { pageAccess } from "@/lib/page";
import { listWorkflows } from "@/lib/queries";
import { triggerOf } from "@/lib/workflow/definition";
import type { TriggerV2 } from "@/lib/workflow/definition-v2";
import { fieldName, typeFieldName } from "@/lib/workflow/manual";
import manifest from "@/platform.app";

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

/** GitHub's names for an event in "Let me select individual events". */
const GITHUB_EVENT_LABELS: Record<string, string> = {
  issues: "Issues",
  issue_comment: "Issue comments",
  pull_request: "Pull requests",
  pull_request_review: "Pull request reviews",
  push: "Pushes",
  release: "Releases",
  workflow_run: "Workflow runs",
};

/** What to set in GitHub's settings for a GitHub hook. */
function GithubSteps({ url, trigger }: { url: string; trigger: Extract<TriggerV2, { type: "github" }> }) {
  const events = [...new Set(trigger.events.map((e) => e.split(".")[0]!))];
  return (
    <ol data-testid="github-steps">
      <li>
        On GitHub, in {trigger.repos.length > 1 ? "each repository" : <span className="mono">{trigger.repos[0]}</span>}:{" "}
        <b>Settings → Webhooks → Add webhook</b>.
      </li>
      <li>
        <b>Payload URL</b>: <span className="mono">{url}</span>
      </li>
      <li>
        <b>Content type</b>: <span className="mono">application/json</span>
      </li>
      <li>
        <b>Secret</b>: the secret shown once when it was generated (generate a new one here if it&apos;s lost).
      </li>
      <li>
        <b>Which events</b>: &quot;Let me select individual events&quot;, then{" "}
        {events.map((e, i) => (
          <span key={e}>
            {i ? ", " : ""}
            <b>{GITHUB_EVENT_LABELS[e] ?? e}</b>
          </span>
        ))}
        .
      </li>
      <li>
        Keep <b>Active</b> ticked and add it: GitHub sends a ping, which this hook answers 200.
      </li>
    </ol>
  );
}

/** A webhook or GitHub workflow's hook, for flow.workflows.write: its URL, a new secret, delete; or create one. */
function HookSection({
  workflow,
  trigger,
  hook,
}: {
  workflow: string;
  trigger: TriggerV2;
  hook: HookSummary | undefined;
}) {
  const kind = trigger.type === "github" ? "github" : "generic";
  const target: HookTarget = {
    domain: manifest.domains?.primary ?? "localhost",
    body: trigger.type === "webhook" ? sampleBody(trigger.input) : "{}",
  };
  if (!hook)
    return (
      <div className="card" data-testid="hook">
        <p className="muted">No hook yet: create one for its URL and secret.</p>
        <CreateHookForm workflow={workflow} kind={kind} target={target} />
      </div>
    );
  const url = hookUrl(target.domain, hook.id);
  const named = (trigger.type === "webhook" || trigger.type === "github") && trigger.hook === hook.id;
  return (
    <div className="card" data-testid="hook" data-hook={hook.id}>
      <p>
        {hook.kind === "github" ? "GitHub hook" : "Hook"}:{" "}
        <span className="mono" data-testid="hook-url">
          {url}
        </span>
      </p>
      <p className="muted">
        created {at(hook.createdAt)} · last called {at(hook.lastCalledAt)}
      </p>
      {named ? null : (
        <p className="notice warn" role="status" data-testid="hook-not-named">
          The published trigger doesn&apos;t name this hook: publish a version whose trigger has{" "}
          <span className="mono">&quot;hook&quot;: &quot;{hook.id}&quot;</span>. Until then calls answer 409.
        </p>
      )}
      {trigger.type === "github" ? <GithubSteps url={url} trigger={trigger} /> : null}
      <details>
        <summary>A signed test call (curl)</summary>
        <pre className="mono" data-testid="hook-curl">
          {curlExample({ url, kind: hook.kind, body: target.body })}
        </pre>
      </details>
      <RegenerateHookForm hookId={hook.id} target={target} />
      <form action={deleteHookAction}>
        <input type="hidden" name="hookId" value={hook.id} />
        <button type="submit" className="secondary" data-testid="delete-hook">
          Delete the hook
        </button>
      </form>
    </div>
  );
}

/**
 * The workflows and their current definition, read-only; Pause and Resume for flow.workflows.write;
 * "Run now" for a manual trigger, with flow.runs.start; a webhook or GitHub trigger's hook, with
 * flow.workflows.write.
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
            {canWrite && (trigger.type === "webhook" || trigger.type === "github" || hooks.has(w.key)) ? (
              <HookSection workflow={w.key} trigger={trigger} hook={hooks.get(w.key)} />
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
