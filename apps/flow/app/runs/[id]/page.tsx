import { notFound } from "next/navigation";
import { cancelRunAction, retryRunAction } from "@/app/actions";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Status } from "@/components/Runs";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { at, RUN_ID, took } from "@/lib/format";
import { pageAccess } from "@/lib/page";
import { getRun } from "@/lib/queries";

export const dynamic = "force-dynamic";

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** One run: each step with its status, timing, input, output and error; Retry and Cancel for flow.runs.start. */
export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess();
  if (!access.ok) {
    return (
      <Shell current="/runs">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { id } = await params;
  const { error, permission } = await searchParams;
  const found = RUN_ID.test(id) ? await getRun(await db(), id) : undefined;
  if (!found) notFound();
  const { run, version, steps, approvals } = found;
  const canStart = access.permissions.includes("flow.runs.start");
  const canDecide = access.permissions.includes("flow.approvals.decide");
  const reached = new Map(steps.map((s) => [s.stepKey, s]));

  return (
    <Shell current="/runs">
      <p className="muted">
        <a href="/runs">Runs</a> / <span className="mono">{run.id}</span>
      </p>
      <h1>
        {run.workflowKey} <span className="muted">v{run.version}</span> <Status value={run.status} />
      </h1>
      <ErrorNotice error={error} permission={permission} />
      <dl className="facts card">
        <dt>Started</dt>
        <dd>{at(run.startedAt)}</dd>
        <dt>Ended</dt>
        <dd>{at(run.endedAt)}</dd>
        <dt>Trigger event</dt>
        <dd className="mono">{run.triggerEventId}</dd>
        {run.errorCode ? (
          <>
            <dt>Error</dt>
            <dd className="mono" data-testid="run-error">
              {run.errorCode}
            </dd>
          </>
        ) : null}
      </dl>

      {canStart ? (
        <div className="actions">
          {run.status === "failed" ? (
            <form action={retryRunAction}>
              <input type="hidden" name="runId" value={run.id} />
              <button type="submit" data-testid="retry">
                Retry
              </button>
            </form>
          ) : null}
          {["running", "waiting", "failed"].includes(run.status) ? (
            <form action={cancelRunAction}>
              <input type="hidden" name="runId" value={run.id} />
              <button type="submit" className="secondary" data-testid="cancel">
                Cancel run
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      <h2>Steps</h2>
      <ol className="steps">
        {version.definition.steps.map((def) => {
          const s = reached.get(def.key);
          return (
            <li key={def.key} className="card step" data-testid="step" data-step={def.key}>
              <div className="step-head">
                <strong className="mono">{def.key}</strong> <span className="muted">{def.type}</span>{" "}
                {s ? <Status value={s.status} /> : <span className="muted">not reached</span>}
              </div>
              {s && def.type === "approval"
                ? approvals
                    .filter((a) => a.stepId === s.id)
                    .map((a) => (
                      <div key={a.id} className="notice" data-testid="approval" data-approval={a.status}>
                        Approval <Status value={a.status} /> for the role <span className="perm">{def.role}</span>, due{" "}
                        {at(a.deadline)}
                        {a.decidedAt ? (
                          <>
                            {" "}
                            · {a.status} by <span className="mono">{a.decidedBy}</span> at {at(a.decidedAt)}
                          </>
                        ) : null}
                        {a.edited ? <> · edited: {Object.keys(a.edited).join(", ")}</> : null}
                        {a.comment ? <span className="pre-wrap"> · “{a.comment}”</span> : null}
                        {a.status === "pending" && canDecide ? (
                          <>
                            {" "}
                            · <a href={`/approvals/${a.id}`}>Review it</a>
                          </>
                        ) : null}
                      </div>
                    ))
                : null}
              {s ? (
                <>
                  <dl className="facts">
                    <dt>Started</dt>
                    <dd>{at(s.startedAt)}</dd>
                    <dt>Took</dt>
                    <dd>{took(s.startedAt, s.endedAt)}</dd>
                    {s.timeoutAt && s.status === "waiting" ? (
                      <>
                        <dt>Times out</dt>
                        <dd>{at(s.timeoutAt)}</dd>
                      </>
                    ) : null}
                    <dt>Attempts</dt>
                    <dd>{s.attempts}</dd>
                    {s.requestEventId ? (
                      <>
                        <dt>Request event</dt>
                        <dd className="mono">{s.requestEventId}</dd>
                      </>
                    ) : null}
                    {s.outcomeEventId ? (
                      <>
                        <dt>Outcome event</dt>
                        <dd className="mono">{s.outcomeEventId}</dd>
                      </>
                    ) : null}
                    {s.errorCode ? (
                      <>
                        <dt>Error</dt>
                        <dd>
                          <span className="mono" data-testid="step-error">
                            {s.errorCode}
                          </span>
                          {s.errorMessage ? <> · {s.errorMessage}</> : null}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {s.input !== null ? (
                    <details>
                      <summary>Input</summary>
                      <pre>{json(s.input)}</pre>
                    </details>
                  ) : null}
                  {s.output !== null ? (
                    <details>
                      <summary>Output</summary>
                      <pre>{json(s.output)}</pre>
                    </details>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Shell>
  );
}
