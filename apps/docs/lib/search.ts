/**
 * The ⌘K search (#80): every document's title, folders and headings, built from the listing the
 * first time someone searches and kept until the listing changes (a new tree sha, or Refresh).
 * Titles and headings only: the body text never leaves the server through this index.
 */
import { breadcrumbOf, headingsOf, titleOf } from "./outline";
import { SourceUnavailableError, type DocSource } from "./source";

export interface SearchEntry {
  path: string;
  title: string;
  /** Readable folder names, e.g. ["Ventures", "Demo App"]. */
  crumbs: string[];
  headings: { text: string; id: string }[];
}

let cached: { sha: string; index: Promise<SearchEntry[]> } | undefined;

/** Reads the documents a few at a time, so a big repository doesn't open hundreds of requests at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function searchIndex(source: DocSource): Promise<SearchEntry[]> {
  const listing = await source.listDocs();
  if (cached?.sha === listing.sha) return cached.index;
  const docs = listing.entries.filter((e) => e.kind === "doc").map((e) => e.path);
  const index = mapLimit(docs, 8, async (p): Promise<SearchEntry | null> => {
    try {
      const markdown = await source.readDoc(p);
      const headings = headingsOf(markdown)
        .filter((h) => h.level > 1)
        .map(({ text, id }) => ({ text, id }));
      return { path: p, title: titleOf(p, markdown), crumbs: breadcrumbOf(p), headings };
    } catch (err) {
      // One unreadable document doesn't hide the others; an unreachable source fails the search.
      if (err instanceof SourceUnavailableError) throw err;
      return null;
    }
  }).then((all) => all.filter((e): e is SearchEntry => e !== null));
  cached = { sha: listing.sha, index };
  index.catch(() => {
    if (cached?.index === index) cached = undefined;
  });
  return index;
}

/** Test-only: forget the cached index. */
export const resetSearchIndex = () => {
  cached = undefined;
};
