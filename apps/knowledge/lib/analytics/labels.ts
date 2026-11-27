/** A page key as words, for the Insights page: "topic:web" is "Topic: web". Unknown keys are shown as they are. */
export function pageLabel(key: string): string {
  if (key === "home") return "Home page";
  if (key === "courses") return "Courses list";
  if (key === "search") return "Search";
  const colon = key.indexOf(":");
  if (colon > 0) {
    const kind = key.slice(0, colon);
    const rest = key.slice(colon + 1);
    if (kind === "topic") return `Topic: ${rest}`;
    if (kind === "course") return `Course: ${rest}`;
    if (kind === "lesson") return `Lessons of ${rest}`;
    if (kind === "article") return `Article: ${rest}`;
  }
  return key;
}

export const SHARE_LABELS: Record<string, string> = { linkedin: "LinkedIn", x: "X", email: "Email", copy: "Copy link" };
export const shareLabel = (target: string): string => SHARE_LABELS[target] ?? target;
