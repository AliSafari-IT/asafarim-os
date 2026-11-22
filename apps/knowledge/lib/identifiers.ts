/**
 * Identifiers in technical text (#357): the words a reader types to find an exact API, error or language name
 * (`useEffect`, `ERR_CONNECTION_RESET`, `C#`, `Array.prototype.map`, `utf-8`). Full-text search splits or drops
 * these, so the search projection stores them whole, lower-cased, for exact and prefix matches.
 */

/** A run of word characters with the joiners identifiers use inside them, and a trailing # or ++. */
const TOKEN = /[A-Za-z_$][\w$]*(?:[.:-][A-Za-z_$\d][\w$]*)*(?:#|\+\+)?/g;

export const TERM_LIMITS = { length: 64, perDocument: 2_000 } as const;

/**
 * True for a token that looks like code rather than prose: snake_case, camelCase or PascalCase with an inner capital,
 * an all-caps name with a digit or underscore, a dotted or namespaced path, a trailing # or ++, or letters and digits
 * mixed (http2, es2024, utf-8).
 */
export function isCodeLike(token: string): boolean {
  if (token.length < 2) return false;
  if (/#$|\+\+$/.test(token)) return true;
  if (/_/.test(token.replace(/^_+|_+$/g, ""))) return true;
  if (/[a-z][A-Z]/.test(token)) return true;
  if (/^[A-Z]{2,}[A-Z0-9]*$/.test(token) && /\d/.test(token)) return true;
  if (/[A-Za-z][.:][A-Za-z_$]/.test(token)) return true;
  if (/[A-Za-z]/.test(token) && /\d/.test(token)) return true;
  return false;
}

const clean = (t: string) => t.toLowerCase().slice(0, TERM_LIMITS.length);

/** Every token of a text, lower-cased (code spans and code blocks: everything there is an identifier). */
export function allTokens(text: string): string[] {
  return (text.match(TOKEN) ?? []).filter((t) => t.length >= 2).map(clean);
}

/** The code-like tokens of prose, lower-cased. */
export function codeTokens(text: string): string[] {
  return (text.match(TOKEN) ?? []).filter(isCodeLike).map(clean);
}

/** The query's words as the projection stores terms: every token, lower-cased, deduplicated. */
export function queryTerms(q: string): string[] {
  return [...new Set(allTokens(q))].slice(0, 12);
}

/** Deduplicated and bounded, for one document. */
export function uniqueTerms(...lists: string[][]): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    for (const t of list) {
      if (out.size >= TERM_LIMITS.perDocument) return [...out];
      out.add(t);
    }
  }
  return [...out];
}
