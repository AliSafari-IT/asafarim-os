/** How the pages write times: UTC, to the second, and short durations. */
export const at = (d: Date | null) => (d ? `${d.toISOString().slice(0, 19).replace("T", " ")} UTC` : "–");

export function took(from: Date | null, to: Date | null): string {
  if (!from || !to) return "–";
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** A run id as the URL takes it: a ULID, nothing else. */
export const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
