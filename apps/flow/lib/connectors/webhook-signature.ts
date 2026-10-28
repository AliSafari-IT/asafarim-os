/**
 * The signature on a webhook Flow sends (`webhook.send`), and how a receiver checks it:
 *
 *   X-Flow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *
 * keyed with the webhook-secret credential as it was shown (its base64url text, as UTF-8). The time is
 * signed with the body, so a receiver refuses an old delivery replayed (`toleranceSeconds`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Flow-Signature";
export const DELIVERY_HEADER = "X-Flow-Delivery";
/** How far a signature's time may be from the receiver's clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const hmac = (secret: string, t: number, body: string) =>
  createHmac("sha256", Buffer.from(secret, "utf8")).update(`${t}.${body}`, "utf8").digest("hex");

/** The header's value for `body`, signed at `t` (unix seconds). */
export function signatureHeader(secret: string, body: string, t: number): string {
  return `t=${t},v1=${hmac(secret, t, body)}`;
}

/** Whether `header` signs `body` with `secret`, at a time within the tolerance of `now` (unix seconds). */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  now: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > toleranceSeconds) return false;
  return timingSafeEqual(Buffer.from(m[2]!, "hex"), Buffer.from(hmac(secret, t, body), "hex"));
}
