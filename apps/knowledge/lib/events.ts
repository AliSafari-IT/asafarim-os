/**
 * The events Knowledge publishes (ADR 0001), through its own outbox (`asafarim_outbox`, migration 13), in the same
 * transaction as the write they describe. The relay (lib/event-relay.ts) sends them to the bus; without a bus they
 * wait in the outbox. The publisher checks every payload against the manifest's JSON Schema before writing.
 */
import { createPublisher, type Queryable } from "@asafarim/app-sdk/events";
import type { Comment } from "@asafarim/engagement";
import { activeTraceContext } from "@asafarim/telemetry";
import manifest from "../platform.app";
import { lessonCourseId } from "./engagement-rollups";
import { EVENT_SCHEMAS } from "./schemas";

export const COMMENT_CREATED = "knowledge.comment.created.v1";

/** What `knowledge.comment.created.v1` carries (events/knowledge.comment.created.v1.json): never the text or a name. */
export interface CommentCreatedV1 {
  commentId: string;
  lessonId: string;
  courseId: string | null;
  parentId: string | null;
  author: string;
  createdAt: string;
}

export const publisher = createPublisher({
  manifest,
  schemas: EVENT_SCHEMAS,
  traceContext: activeTraceContext,
});

/**
 * Write knowledge.comment.created.v1 for a new comment to the outbox, through the comment's own transaction (the
 * engagement service's onCommentCreated hook): no comment without its event, no event for a rolled-back comment.
 */
export async function publishCommentCreated(tx: Queryable & Parameters<typeof lessonCourseId>[0], comment: Comment) {
  await publisher.publish<CommentCreatedV1>(
    tx,
    COMMENT_CREATED,
    {
      commentId: comment.id,
      lessonId: comment.entityId,
      courseId: await lessonCourseId(tx, comment.entityId),
      parentId: comment.parentId,
      author: comment.userId,
      createdAt: comment.createdAt,
    },
    { subject: comment.id },
  );
}
