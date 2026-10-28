/**
 * A workflow's hook (lib/hooks): what the Workflows page and the builder's trigger settings show of it,
 * for flow.workflows.write. Rendered on the server; its forms are components/HookForms.tsx.
 */
import { deleteHookAction } from "@/app/actions";
import { CreateHookForm, RegenerateHookForm, type HookTarget } from "@/components/HookForms";
import { at } from "@/lib/format";
import { curlExample, hookUrl, sampleBody } from "@/lib/hooks/example";
import type { HookSummary } from "@/lib/hooks/store";
import type { TriggerV2 } from "@/lib/workflow/definition-v2";
import manifest from "@/platform.app";

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

/**
 * A webhook or GitHub workflow's hook, for flow.workflows.write: its URL, a new secret, delete; or create
 * one. On the Workflows page and in the builder's trigger settings. `checkNamed`: warn when `trigger`
 * (the published one) doesn't name the hook; the builder says so itself, about the draft's.
 */
export function HookSection({
  workflow,
  trigger,
  hook,
  checkNamed = true,
  back,
}: {
  workflow: string;
  trigger: TriggerV2;
  hook: HookSummary | undefined;
  checkNamed?: boolean;
  /** Where deleting the hook goes back to (the builder); the Workflows page by default. */
  back?: string;
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
  const named = !checkNamed || ((trigger.type === "webhook" || trigger.type === "github") && trigger.hook === hook.id);
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
        {back ? <input type="hidden" name="back" value={back} /> : null}
        <button type="submit" className="secondary" data-testid="delete-hook">
          Delete the hook
        </button>
      </form>
    </div>
  );
}
