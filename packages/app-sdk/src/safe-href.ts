/** Only http(s) links are rendered: a tile can't smuggle in `javascript:`. */
export function safeHref(href: string): string | undefined {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
