import { DONE, ERRORS } from "@/lib/messages";

/** The outcome of the last studio action (from the redirect's query), as an alert or a status line. */
export function Notices({ error, done, detail }: { error?: string; done?: string; detail?: string }) {
  return (
    <>
      {error ? (
        <div className="notice bad" role="alert" data-testid="error">
          {ERRORS[error] ?? "Something went wrong."}
          {detail ? (
            <>
              {" "}
              (<code>{detail.slice(0, 60)}</code>)
            </>
          ) : null}
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
