/**
 * Text from core-api for a terminal. Names come from app manifests and refusal messages from
 * core-api, so control characters (an ANSI escape could rewrite the screen) are replaced, and
 * anything not a string becomes "?".
 */
export function clean(v: unknown): string {
  if (typeof v !== "string") return "?";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}
