import { at } from "@/lib/format";
import type { RunSummary } from "@/lib/queries";

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`} data-testid="status">
      {value.replace("_", " ")}
    </span>
  );
}

/** A table of runs, each linking to its Run page. */
export function RunTable({ runs, empty, testId }: { runs: RunSummary[]; empty: string; testId: string }) {
  if (!runs.length) {
    return (
      <p className="muted" data-testid={`${testId}-empty`}>
        {empty}
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Workflow</th>
            <th scope="col">Status</th>
            <th scope="col">At step</th>
            <th scope="col">Started</th>
            <th scope="col">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} data-testid="run">
              <td>
                <a href={`/runs/${r.id}`} className="mono">
                  {r.id.slice(-8)}
                </a>
              </td>
              <td>
                {r.workflowKey} <span className="muted">v{r.version}</span>
              </td>
              <td>
                <Status value={r.status} />
              </td>
              <td className="mono">{r.currentStep ?? "–"}</td>
              <td>{at(r.startedAt)}</td>
              <td className="mono">{r.errorCode ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
