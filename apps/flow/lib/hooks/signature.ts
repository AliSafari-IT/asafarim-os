/**
 * The signatures a hook checks, over the raw body as received (never a re-serialised parse):
 *
 *   generic  X-Flow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">, t within ±5 minutes
 *   github   X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>
 *
 * The key is the hook's webhook secret as text (what a sender pastes). Digests are compared with
 * timingSafeEqual on two 32-byte buffers; a header that doesn't parse is compared against a digest of
 * zeros all the same, so a malformed signature costs what a wrong one does.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How far the generic signature's timestamp may be from the server's clock. */
export const TOLERANCE_SECONDS = 5 * 60;

const HEX64 = /^[0-9a-f]{64}$/;
const GENERIC = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;
const ZEROS = Buffer.alloc(32);

const hmac = (secret: string, ...parts: (string | Uint8Array)[]) => {
  const h = createHmac("sha256", secret);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Whether `given` (hex, maybe malformed) is the digest `expected`, in constant time. */
function sameDigest(expected: Buffer, given: string | undefined): boolean {
  const ok = given !== undefined && HEX64.test(given);
  const g = ok ? Buffer.from(given, "hex") : ZEROS;
  return timingSafeEqual(expected, g) && ok;
}

export type Verdict =
  { ok: true; signature: string } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/** The generic signature: `header` over `body`, at `now`. */
export function verifyGeneric(secret: string, header: string | null, body: Uint8Array, now: Date): Verdict {
  const m = header === null ? null : GENERIC.exec(header.trim());
  const t = m?.[1] ?? "0";
  const ok = sameDigest(hmac(secret, t, ".", body), m?.[2]);
  if (header === null) return { ok: false, reason: "missing" };
  if (!m) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(t)) > TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  return ok ? { ok: true, signature: m[2]! } : { ok: false, reason: "mismatch" };
}

/** GitHub's signature: `header` over `body`. */
export function verifyGithub(secret: string, header: string | null, body: Uint8Array): Verdict {
  const given = header?.trim().startsWith("sha256=") ? header.trim().slice(7) : undefined;
  const ok = sameDigest(hmac(secret, body), given);
  if (header === null) return { ok: false, reason: "missing" };
  if (given === undefined || !HEX64.test(given)) return { ok: false, reason: "malformed" };
  return ok ? { ok: true, signature: given } : { ok: false, reason: "mismatch" };
}

/** What a sender of a generic hook puts in X-Flow-Signature (the UI's example; tests). */
export function signGeneric(secret: string, body: string | Uint8Array, t: number): string {
  return `t=${t},v1=${hmac(secret, String(t), ".", body).toString("hex")}`;
}

/** What GitHub puts in X-Hub-Signature-256 (tests). */
export function signGithub(secret: string, body: string | Uint8Array): string {
  return `sha256=${hmac(secret, body).toString("hex")}`;
}

/**
 * The same work as a verification, for a hook that doesn't exist: the answer then takes the shape a
 * bad signature's does.
 */
export function verifyNothing(body: Uint8Array): void {
  sameDigest(hmac("no hook", body), undefined);
}
