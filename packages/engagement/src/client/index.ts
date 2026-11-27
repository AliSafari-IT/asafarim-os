/**
 * `@asafarim/engagement/client`: the React side. LikeButton and CommentSection are client components; the badge is
 * plain markup a server component can render. Style them with `@asafarim/engagement/styles.css` (theme tokens).
 */
export { LikeButton, type LikeButtonProps } from "./LikeButton.tsx";
export { CommentSection, type CommentSectionProps, type CommentViewer } from "./CommentSection.tsx";
export { EngagementBadge, type EngagementBadgeProps } from "./EngagementBadge.tsx";
export {
  compactCount,
  createEngagementClient,
  DEFAULT_BASE_PATH,
  EngagementApiError,
  insertComment,
  likedHint,
  removeComment,
  replaceComment,
  type ClientComment,
  type ClientThread,
  type EngagementClient,
  type EntityTarget,
  type LikeState,
} from "./api.ts";
