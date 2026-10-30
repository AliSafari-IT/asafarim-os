/**
 * Strip what looks like a secret from issue text before it is sent to the AI (#283): tokens, keys and
 * passwords pasted into an issue must not leave for an outside provider. A match becomes `[redacted]`.
 * Over-matching is the safe side: the text is only a description for drafting a workflow.
 */

export const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  // PEM private keys, whole block.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained (github_pat_).
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  // GitLab personal, deploy and runner tokens.
  /\bgl(?:pat|dt|rt|ptt|ft|cbt|imt|agent|oas)-[A-Za-z0-9_-]{16,255}\b/g,
  // Anthropic, OpenAI-style and similar `sk-` keys.
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,255}\b/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  // JSON Web Tokens: three base64url parts, the first a JSON header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Credentials in a URL: scheme://user:password@host.
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
  // `password = …`, `token: …`, `api_key=…`, `secret …` and the like: the value goes, the name stays.
  /\b((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
  // `Bearer <token>`.
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g,
];

/** A long run of base64 or hex: likely a key even without a known prefix. */
const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, mixed and random-looking: letters and digits, high entropy (a word, a path or a hash rarely is). */
const looksRandom = (s: string) => entropy(s) >= 4 && /[A-Za-z]/.test(s) && /\d/.test(s);

/** `text` without secrets, and how many were replaced. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      redactions++;
      // Patterns with a first group keep it (the `password =` or `https://` part) and drop the rest.
      const prefix = typeof args[1] === "string" && args.length > 3 ? (args[1] as string) : "";
      return `${prefix}${REDACTED}`;
    });
  }
  out = out.replace(HIGH_ENTROPY, (match) => {
    if (!looksRandom(match)) return match;
    redactions++;
    return REDACTED;
  });
  return { text: out, redactions };
}
