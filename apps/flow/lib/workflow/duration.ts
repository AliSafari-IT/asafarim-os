/**
 * ISO 8601 durations, the part a workflow needs: days, hours, minutes and seconds (`PT5M`, `P7D`,
 * `P1DT12H`). No years, months or weeks: their length depends on the calendar.
 */
const DURATION = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?)?$/;

/** The duration in milliseconds, or undefined when it isn't one of the accepted forms (or is zero). */
export function durationMs(text: string): number | undefined {
  const m = DURATION.exec(text);
  if (!m || text === "P" || text.endsWith("T")) return undefined;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  const ms = (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
  return ms > 0 ? ms : undefined;
}
