/**
 * A line diff for the studio's revision comparison (#372): what was removed, added and kept between two plain texts
 * (a revision's `body`: one block per line). The longest common subsequence of lines, after trimming the common
 * start and end; past a size bound the middle is shown as replaced rather than spending quadratic time on it.
 */

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Above this many cells (lines × lines in the differing middle), the middle is a plain replacement. */
export const DIFF_CELL_LIMIT = 2_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ kind: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: "same" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...middle(midA, midB), ...tail];
}

function middle(a: string[], b: string[]): DiffLine[] {
  const removed = (text: string) => ({ kind: "removed" as const, text });
  const added = (text: string) => ({ kind: "added" as const, text });
  if (a.length === 0 || b.length === 0 || a.length * b.length > DIFF_CELL_LIMIT) {
    return [...a.map(removed), ...b.map(added)];
  }
  // lcs[i * w + j]: the LCS length of a[i..] and b[j..].
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) out.push(removed(a[i++]!));
    else out.push(added(b[j++]!));
  }
  while (i < a.length) out.push(removed(a[i++]!));
  while (j < b.length) out.push(added(b[j++]!));
  return out;
}

/** Counts for the comparison's summary line. */
export function diffStats(lines: DiffLine[]) {
  return {
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
  };
}
