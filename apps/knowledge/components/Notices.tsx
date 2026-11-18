import { DONE, ERRORS } from "@/lib/messages";

/** The outcome of the last studio action (from the redirect's query), as an alert or a status line. */
export function Notices({ error, done }: { error?: string; done?: string }) {
  return (
    <>
      {error ? (
        <div className="notice bad" role="alert" data-testid="error">
          {ERRORS[error] ?? "Something went wrong."}
        </div>
      ) : null}
      {done && DONE[done] ? (
        <div className="notice good" role="status" data-testid="done">
          {DONE[done]}
        </div>
      ) : null}
    </>
  );
}
