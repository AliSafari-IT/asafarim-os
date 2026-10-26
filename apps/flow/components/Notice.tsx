const MESSAGES: Record<string, string> = {
  forbidden: "403 Forbidden: you don't have the permission",
  not_found: "Not found.",
  not_retryable: "Only a failed run can be retried.",
  not_cancellable: "This run has already ended.",
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
