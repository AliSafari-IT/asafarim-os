import { CommentSection, GuestLikeSync, LikeButton } from "@asafarim/engagement/client";
import { signInAction } from "@/app/actions";
import { commentViewer, ENGAGEMENT_BASE_PATH } from "@/lib/engagement";
import type { Counts } from "@/lib/engagement-rollups";

export async function ArticleEngagement({ id, next, counts }: { id: string; next: string; counts: Counts }) {
  const viewer = await commentViewer();
  const entity = { entityType: "article", entityId: id, basePath: ENGAGEMENT_BASE_PATH };
  return (
    <>
      {viewer ? <GuestLikeSync userId={viewer.id} basePath={ENGAGEMENT_BASE_PATH} /> : null}
      <div className="lesson-like" data-testid="lesson-like">
        <LikeButton {...entity} initialCount={counts.likes} label="Helpful" />
      </div>
      <CommentSection
        {...entity}
        viewer={viewer}
        initialCount={counts.comments}
        signIn={
          <form action={signInAction} className="inline-sign-in">
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="secondary" data-testid="comment-sign-in-button">
              Sign in
            </button>{" "}
            to join the conversation.
          </form>
        }
      />
    </>
  );
}
