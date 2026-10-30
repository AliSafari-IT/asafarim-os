const MESSAGES: Record<string, string> = {
  forbidden: "403 Forbidden: you don't have the permission",
  not_found: "Not found.",
  not_retryable: "Only a failed run can be retried.",
  not_cancellable: "This run has already ended.",
  not_pending:
    "409 Conflict: this approval isn't waiting for a decision any more (decided, expired or cancelled), or its run moved on.",
  public_not_acknowledged: "This repository is public: tick the box to confirm you saw that before approving.",
  edit_not_allowed: "This step doesn't let you change that field.",
  invalid_edits:
    "The edits don't fit: a title of 1 to 256 characters, a body of 1 to 60 000, at most 20 labels of 1 to 50 characters each.",
  invalid_comment: "The comment can be 1000 characters at most.",
  not_active: "This workflow is paused: resume it to run it.",
  paused_all: "All workflows are paused. Resume them in Settings to run this one.",
  wrong_trigger: "This workflow isn't started that way.",
  invalid_input: "The fields don't fit: fill in every required one, numbers as numbers.",
  app_inactive: "The app isn't active.",
  unauthenticated: "Sign in first.",
  permissions_unavailable: "Permissions can't be checked right now.",
  credential_not_found: "That credential doesn't exist any more.",
  invalid_entries:
    "An entry doesn't fit: hosts are names like hooks.example.com (or host:port), recipients an address or @domain.",
  too_many_entries: "That's more entries than a list can hold.",
  exists: "A workflow with that key exists already: choose another key.",
  invalid_workflow: "That doesn't fit: a name, and a key of lower case letters, digits and dashes.",
  generate_invalid_url:
    "That isn't an issue URL Flow can read: https://github.com/owner/repo/issues/123 or https://gitlab.com/group/project/-/issues/123.",
  generate_switch_off: "Generating drafts from issues is turned off. An admin can turn it on in Settings.",
  generate_not_configured: "Generating drafts from issues isn't set up on this server.",
  generate_paused: "Flow is paused, so nothing is sent out. Build the workflow by hand, or resume Flow in Settings.",
  generate_paused_all:
    "Flow is paused, so nothing is sent out. Build the workflow by hand, or resume Flow in Settings.",
  generate_cooling_down: "The AI hasn't been answering. Try again in a few minutes, or build the workflow by hand.",
  generate_rate_limited: "You've generated the most drafts allowed for now (5 an hour, 20 a day). Try again later.",
  generate_daily_cap: "Today's AI budget is used up. Try again tomorrow, or build the workflow by hand.",
  generate_credential_not_found: "That credential doesn't exist any more.",
  generate_credential_wrong_kind:
    "That credential is for the other host: use a GitHub token for GitHub, a GitLab token for GitLab.",
  generate_credential_not_for_repo: "That credential doesn't list this repository or project.",
  generate_credentials_unavailable: "Credentials can't be used on this server right now.",
  generate_issue_no_access:
    "Flow couldn't read that issue: it doesn't exist, or it's private. For a private one, choose a token that can read it.",
  generate_not_an_issue: "That's a pull request, not an issue.",
  generate_issue_unavailable: "The issue's host didn't answer properly. Try again in a moment.",
  generate_ai_timeout: "The AI took too long to answer. Try again, or build the workflow by hand.",
  generate_ai_unavailable: "The AI isn't available right now. Try again later, or build the workflow by hand.",
  generate_ai_refused: "The AI declined to draft a workflow from this issue. Build it by hand.",
  generate_invalid_ai_answer:
    "The AI's answer wasn't a workflow Flow can use, so no draft was made. Try again, or build it by hand.",
};

/** The refusal a server action redirected back with (`?error=…&permission=…`). */
export function ErrorNotice({ error, permission }: { error?: string; permission?: string }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert" data-testid="error">
      {MESSAGES[error] ?? "Something went wrong."}
      {permission && /^flow\.[a-z.-]+$/.test(permission) ? (
        <>
          {" "}
          <span className="perm">{permission}</span>
        </>
      ) : null}
    </div>
  );
}

const SAVED_MESSAGES: Record<string, string> = {
  egress_hosts: "Webhook hosts saved.",
  email_recipients: "Email recipients saved.",
  paused: "Flow paused.",
  resumed: "Flow resumed.",
  ai_on: "Generating drafts from issues is on: issue text is sent to Anthropic when someone uses it.",
  ai_off: "Generating drafts from issues is off.",
};

export function SavedNotice({ saved }: { saved?: string }) {
  const message = saved ? SAVED_MESSAGES[saved] : undefined;
  if (!message) return null;
  return (
    <p className="notice" role="status" aria-live="polite" data-testid="saved">
      {message}
    </p>
  );
}

export function Unavailable({ message }: { message: string }) {
  return (
    <p className="notice bad" role="status" data-testid="state">
      {message}
    </p>
  );
}
