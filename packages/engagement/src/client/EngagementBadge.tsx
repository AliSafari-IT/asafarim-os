/**
 * `♥ 124 • 💬 18`: an entity's counts, for outlines and headers. Plain markup (no hooks), so a server component
 * can render it with counts it already read; the screen-reader text says the numbers in words.
 */
import { compactCount } from "./api.ts";

export interface EngagementBadgeProps {
  likes: number;
  comments: number;
  /** Hide the badge entirely when both counts are zero (default true: an outline full of zeros is noise). */
  hideWhenEmpty?: boolean;
  className?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function EngagementBadge({ likes, comments, hideWhenEmpty = true, className }: EngagementBadgeProps) {
  const l = Math.max(0, Math.trunc(likes || 0));
  const c = Math.max(0, Math.trunc(comments || 0));
  if (hideWhenEmpty && l === 0 && c === 0) return null;
  return (
    <span
      className={className ? `engagement-badge ${className}` : "engagement-badge"}
      data-testid="engagement-badge"
      role="img"
      aria-label={`${plural(l, "like", "likes")}, ${plural(c, "comment", "comments")}`}
    >
      <span aria-hidden="true">♥ {compactCount(l)}</span>
      <span aria-hidden="true" className="engagement-badge-sep">
        •
      </span>
      <span aria-hidden="true">💬 {compactCount(c)}</span>
    </span>
  );
}
