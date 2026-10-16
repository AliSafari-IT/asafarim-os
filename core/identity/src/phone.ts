/**
 * Phone numbers for the SMS sign-in method: what a person types becomes one
 * canonical E.164 string (`+32470123456`), the only form stored, compared and
 * sent to the SMS provider.
 */

/** E.164: a plus, a country code that doesn't start with 0, at most 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * `+32 470 12 34 56`, `0032 470/12.34.56` or `(+32) 470-123456` → `+32470123456`.
 * Returns null for anything that isn't a full international number: a national
 * number (`0470…`) has no country, so it is refused rather than guessed.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  // Only digits, a leading plus and the usual separators.
  if (!/^[+\d\s().\-/]+$/.test(trimmed)) return null;
  let compact = trimmed.replace(/[\s().\-/]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  return E164.test(compact) ? compact : null;
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * `IDENTITY_SMS_ALLOWED_PREFIXES` (`+32,+31`) → the prefixes. Each must be a
 * plus and 1 to 6 digits; an empty list is refused.
 */
export function parsePrefixes(raw: string): string[] {
  const prefixes = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0 || prefixes.some((p) => !/^\+[1-9]\d{0,5}$/.test(p))) {
    throw new Error("prefixes must be a comma-separated list like +32,+31");
  }
  return prefixes;
}

export function prefixAllowed(phone: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => phone.startsWith(p));
}

/** `+32470123456` → `+32 ••• ••• 56`: enough for the person to recognise it, no more. */
export function maskPhone(phone: string): string {
  const country = /^\+(1|7|\d{2})/.exec(phone)?.[0] ?? phone.slice(0, 3);
  return `${country} ••• ••• ${phone.slice(-2)}`;
}
