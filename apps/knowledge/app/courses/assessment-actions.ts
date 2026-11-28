"use server";
/**
 * A learner's assessment actions: start (or resume) an attempt, and submit it. Signed in is enough; the attempt is
 * theirs alone, the answers are graded on the server, and the retake lock is enforced there too.
 */
import { redirect } from "next/navigation";
import { startAttempt, submitAttempt } from "@/lib/assessments";
import { isUuid } from "@/lib/content";
import { db } from "@/lib/db";
import { learnerGate } from "@/lib/learner";
import { isSlug } from "@/lib/validation";

export async function startAttemptAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  if (!isSlug(slug)) redirect("/courses");
  const page = `/courses/${slug}/assessment`;
  const g = await learnerGate();
  if (!g.ok) redirect(`${page}?error=assessment_${g.error}`);
  const r = await startAttempt(await db(), g.subject, slug);
  if (!r.ok) redirect(`${page}?error=assessment_${r.error}`);
  redirect(`${page}/attempts/${r.id}`);
}

export type SubmitResult = { ok: false; error: string };

/** Called by the runner with the chosen option ids per question; lands on the result. */
export async function submitAttemptAction(
  slug: string,
  attemptId: string,
  answers: Record<string, string[]>,
): Promise<SubmitResult> {
  if (!isSlug(String(slug)) || !isUuid(String(attemptId))) return { ok: false, error: "assessment_attempt_closed" };
  const g = await learnerGate();
  if (!g.ok) return { ok: false, error: `assessment_${g.error}` };
  const r = await submitAttempt(await db(), g.subject, attemptId, answers);
  if (!r.ok && r.error !== "attempt_closed") return { ok: false, error: `assessment_${r.error}` };
  redirect(`/courses/${slug}/assessment/attempts/${attemptId}?submitted=1`);
}
