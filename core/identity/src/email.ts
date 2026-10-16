/**
 * Email addresses for the email-code sign-in method: one canonical form
 * (trimmed, lower-cased), the only form stored, compared and mailed to.
 */

/** Deliberately simple: a local part, an @, a domain with a dot; no spaces, no quotes, no angle brackets. */
const EMAIL = /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]+$/;

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return EMAIL.test(email) ? email : null;
}

/** `ali.safari@example.com` → `a•••i@example.com`: enough to recognise it, no more. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.length <= 2 ? `${local[0] ?? ""}•••` : `${local[0]}•••${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}
