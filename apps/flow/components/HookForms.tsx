"use client";
/**
 * A workflow's hook on the Workflows page: create one, or generate a new secret. The secret comes back
 * in the action's answer and is shown here once, with the curl example filled in (kept in this
 * component's state only, never in a URL). Everywhere else the example has a placeholder for it.
 */
import { useActionState } from "react";
import { createHookAction, regenerateHookAction } from "@/app/actions";
import { curlExample, hookUrl, type HookFormState } from "@/lib/hooks/example";
import type { HookKind } from "@/lib/hooks/store";

const MESSAGES: Record<string, string> = {
  hook_exists: "This workflow has a hook already.",
  invalid_hook: "That isn't a kind of hook.",
  credentials_unavailable: "Credentials aren't set up on this server: a hook needs one for its secret.",
  credential_name_taken: "Its secret's name is taken: try again.",
  forbidden: "403 Forbidden: you don't have the permission",
  not_found: "Not found.",
};

/** Where the example sends its test body, and which: from the server (the app's domain, the trigger's input). */
export interface HookTarget {
  domain: string;
  body: string;
}

function Answer({ state, target }: { state: HookFormState; target: HookTarget }) {
  if (state.status === "error")
    return (
      <p className="notice bad" role="alert" data-testid="hook-error">
        {MESSAGES[state.error] ?? "Something went wrong."}
        {state.permission ? <span className="perm"> {state.permission}</span> : null}
      </p>
    );
  if (state.status === "done" && state.secret)
    return (
      <div className="notice warn" role="status" data-testid="hook-shown-once">
        <p>Copy this secret now: it won&apos;t be shown again.</p>
        <pre className="mono" data-testid="hook-secret">
          {state.secret}
        </pre>
        <p>A signed test call:</p>
        <pre className="mono" data-testid="hook-curl-signed">
          {curlExample({
            url: hookUrl(target.domain, state.hookId),
            kind: state.kind,
            body: target.body,
            secret: state.secret,
          })}
        </pre>
      </div>
    );
  return null;
}

export function CreateHookForm({ workflow, kind, target }: { workflow: string; kind: HookKind; target: HookTarget }) {
  const [state, action, pending] = useActionState(createHookAction, { status: "idle" });
  return (
    <form action={action} data-testid="create-hook">
      <input type="hidden" name="workflow" value={workflow} />
      <input type="hidden" name="kind" value={kind} />
      <Answer state={state} target={target} />
      <button type="submit" className="secondary" disabled={pending}>
        Create the {kind === "github" ? "GitHub " : ""}hook
      </button>
    </form>
  );
}

export function RegenerateHookForm({ hookId, target }: { hookId: string; target: HookTarget }) {
  const [state, action, pending] = useActionState(regenerateHookAction, { status: "idle" });
  return (
    <form action={action} data-testid="regenerate-hook">
      <input type="hidden" name="hookId" value={hookId} />
      <Answer state={state} target={target} />
      <button type="submit" className="secondary" disabled={pending}>
        Generate a new secret
      </button>
    </form>
  );
}
