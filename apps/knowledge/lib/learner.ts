/**
 * Who is taking an assessment: anyone signed in, while the app is active. No Knowledge permission is needed to learn;
 * the attempts are kept against the person's subject, and only they ever see them.
 */
import { auth } from "./auth";
import { describeAccess } from "./gate";

export type LearnerGate = { ok: true; subject: string } | { ok: false; error: "unauthenticated" | "unavailable" };

export async function learnerGate(): Promise<LearnerGate> {
  const subject = (await auth())?.user?.id;
  if (!subject) return { ok: false, error: "unauthenticated" };
  const access = await describeAccess(subject);
  if (access.available && access.state !== "active") return { ok: false, error: "unavailable" };
  return { ok: true, subject };
}
