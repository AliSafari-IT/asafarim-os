import { CopyButton } from "@/components/CopyButton";
import { formatTime } from "@/lib/util";

/** A time on one line (2026-10-04 19:31 UTC), with the seconds in the tooltip. */
export function When({ iso }: { iso: string }) {
  const full = formatTime(iso);
  return (
    <time className="os-nowrap" dateTime={iso} title={full}>
      {full.replace(/:\d\d UTC$/, " UTC")}
    </time>
  );
}

/**
 * A long id (user:8cc851a0-9a08-…) on one line: clipped with an ellipsis, the whole of it in the
 * tooltip and in the text (so it can be selected, searched and tested), and a button that copies it.
 */
export function ShortId({ value, testId }: { value: string; testId?: string }) {
  return (
    <span className="os-nowrap">
      <span className="os-id" title={value} data-testid={testId}>
        {value}
      </span>
      {value.length > 16 ? <CopyButton value={value} /> : null}
    </span>
  );
}

/** A JSON value as one clipped line that opens to the whole of it, pretty-printed and wrapped. */
export function JsonDetail({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const line = JSON.stringify(value);
  if (line === "{}" || line === "[]") return <span className="muted mono">{line}</span>;
  return (
    <details className="os-json">
      <summary title="Show all of it">{line}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
