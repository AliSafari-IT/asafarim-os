import { notFound } from "next/navigation";
import { Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { lineDiff, sortedJson } from "@/lib/builder/diff";
import { db } from "@/lib/db";
import { at } from "@/lib/format";
import { pageAccess } from "@/lib/page";
import { getBuilderWorkflow, getVersions } from "@/lib/queries";
import { KEY } from "@/lib/workflow/schema";

export const dynamic = "force-dynamic";

const numberOf = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) ? Number(v) : undefined);

/**
 * A workflow's published versions (flow.read), and two of them compared, read-only: their definition
 * JSON with keys sorted, as a line diff. By default the latest against the one before it.
 */
export default async function Versions({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
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
  const { key } = await params;
  if (!KEY.test(key) || key.length > 64) notFound();
  const pool = await db();
  const workflow = await getBuilderWorkflow(pool, key);
  if (!workflow) notFound();
  const query = await searchParams;
  const numbers = workflow.versions.map((v) => v.version);
  const b = numberOf(query.b) ?? numbers[0];
  const a = numberOf(query.a) ?? numbers.find((n) => b !== undefined && n < b) ?? b;
  const [va, vb] =
    a !== undefined && b !== undefined
      ? await getVersions(pool, key, [a, b]).then((vs) => [
          vs.find((v) => v.version === a),
          vs.find((v) => v.version === b),
        ])
      : [undefined, undefined];
  const diff = va && vb ? lineDiff(sortedJson(va.definition), sortedJson(vb.definition)) : [];
  const changed = diff.filter((l) => l.kind !== "same").length;
  return (
    <Shell current="/workflows">
      <h1>{workflow.name}: versions</h1>
      <p className="muted">
        <span className="mono">{workflow.key}</span> · <a href={`/workflows/${workflow.key}/edit`}>Open the builder</a>
      </p>
      <section className="card">
        <h2>Published</h2>
        {numbers.length ? (
          <ol className="plain" data-testid="versions">
            {workflow.versions.map((v) => (
              <li key={v.version}>
                Version {v.version} · published {at(v.publishedAt)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No version is published yet.</p>
        )}
      </section>
      {numbers.length ? (
        <section className="card" aria-labelledby="compare-h">
          <h2 id="compare-h">Compare</h2>
          <form method="get" className="filters">
            <label htmlFor="a">From version</label>
            <select id="a" name="a" defaultValue={a}>
              {numbers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <label htmlFor="b">to version</label>
            <select id="b" name="b" defaultValue={b}>
              {numbers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary">
              Compare
            </button>
          </form>
          {va && vb ? (
            <>
              <p className="muted" role="status">
                {a === b
                  ? `Version ${a} on its own.`
                  : changed
                    ? `${changed} line${changed === 1 ? "" : "s"} changed from version ${a} to version ${b}.`
                    : `Versions ${a} and ${b} have the same definition.`}
              </p>
              <pre className="diff" data-testid="diff" aria-label={`Definition diff, version ${a} to ${b}`}>
                {diff.map((l, i) => (
                  <span key={i} className={`diff-${l.kind}`}>
                    <span aria-hidden="true">{l.kind === "added" ? "+ " : l.kind === "removed" ? "- " : "  "}</span>
                    {l.kind !== "same" ? <span className="visually-hidden">{l.kind}: </span> : null}
                    {l.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </>
          ) : (
            <p className="muted">Choose two versions that exist.</p>
          )}
        </section>
      ) : null}
    </Shell>
  );
}
