/**
 * Whether likes and comments are on, and their salt: a module of its own (no `server-only`, no Next imports) so
 * instrumentation.ts can ask too.
 */
import { MIN_SALT_LENGTH } from "@asafarim/engagement";

/** ENGAGEMENT_SALT, when it is usable. */
export function engagementSalt(): string | null {
  const s = process.env.ENGAGEMENT_SALT;
  return s && s.length >= MIN_SALT_LENGTH ? s : null;
}

/** Whether likes and comments are switched on (ENGAGEMENT_SALT is set). Pages hide their UI otherwise. */
export function engagementEnabled(): boolean {
  return engagementSalt() !== null;
}
