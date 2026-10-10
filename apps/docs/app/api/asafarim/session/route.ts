/**
 * GET /api/asafarim/session (ACCESS_SESSION_PATH): where the OS gateway sends a
 * browser whose access token is missing or has expired. Signed in → a fresh
 * short-lived token cookie, then back to `?next=`; not signed in → sign-in first.
 */
import { createSessionHandler } from "@asafarim/app-sdk";
import { auth } from "@/lib/auth";
import { getPlatform } from "@/lib/platform";

export const dynamic = "force-dynamic";

export const GET = createSessionHandler({
  subject: async () => (await auth())?.user?.id ?? undefined,
  mintToken: (subject) => getPlatform().access.mintToken(subject),
});
