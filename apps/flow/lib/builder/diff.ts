/** Two versions side by side: their definition JSON with keys sorted, and a line diff of it. Pure. */

/** `value` as JSON, two-space indented, every object's keys in order. */
export function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** The lines of `a` and `b` as one list: kept, removed (only in `a`), added (only in `b`). LCS. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // Lengths of the longest common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: "same", text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "removed", text: x[i++]! });
    else out.push({ kind: "added", text: y[j++]! });
  }
  while (i < x.length) out.push({ kind: "removed", text: x[i++]! });
  while (j < y.length) out.push({ kind: "added", text: y[j++]! });
  return out;
}
