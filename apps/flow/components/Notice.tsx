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
  app_inactive: "The app isn't active.",
  unauthenticated: "Sign in first.",
  permissions_unavailable: "Permissions can't be checked right now.",
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

export function Unavailable({ message }: { message: string }) {
  return (
    <p className="notice bad" role="status" data-testid="state">
      {message}
    </p>
  );
}
