/** A page's query parameters as Next.js passes them: a repeated one (?q=a&q=b) arrives as an array. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** One value per parameter: a repeated one uses its first. */
export const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
