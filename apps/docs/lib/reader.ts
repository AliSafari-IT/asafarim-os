/**
 * What the reading page shows (#78): the tree, and the selected document with the repository that
 * owns it. Kept apart from the page so it can be tested without Next.js.
 */
import {
  breadcrumbOf,
  headingsOf,
  issueLinksBySection,
  statsOf,
  titleOf,
  type DocStats,
  type Heading,
} from "./outline";
import { ownerOf, type Owner } from "./owners";
import { DocNotFoundError, SourceUnavailableError, type DocEntry, type DocSource } from "./source";

export interface TreeNode {
  name: string;
  /** Set for a file. */
  entry?: DocEntry;
  children: TreeNode[];
}

/** Nest the flat listing into folders; folders first, then files, each by name. */
export function buildTree(entries: DocEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", children: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.children.find((c) => !c.entry && c.name === part);
      if (!next) {
        next = { name: part, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.children.push({ name: parts.at(-1)!, entry, children: [] });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => Number(Boolean(a.entry)) - Number(Boolean(b.entry)) || a.name.localeCompare(b.name))
      .map((n) => ({ ...n, children: sort(n.children) }));
  return sort(root.children);
}

export { titleOf };

/** A `?doc=` value worth looking up: a relative .md path without `..`, or nothing. */
export function docParam(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 500) return undefined;
  if (!/^[A-Za-z0-9._ /-]+\.md$/i.test(raw) || raw.startsWith("/") || raw.split("/").includes("..")) return undefined;
  return raw;
}

export type ReaderView =
  | { status: "unavailable"; reason: string }
  | {
      status: "ok";
      mode: DocSource["mode"];
      tree: TreeNode[];
      docCount: number;
      /** What links inside a document may open: the listing's documents and images. */
      paths: { docs: string[]; images: string[] };
      /** docs-app.json couldn't be used: shown, and every document falls back to the source repo. */
      ownersError?: string;
      doc?:
        | {
            missing: false;
            path: string;
            title: string;
            markdown: string;
            owner: Owner;
            headings: Heading[];
            breadcrumb: string[];
            stats: DocStats;
            issueLinks: Record<string, string[]>;
          }
        | { missing: true; path: string };
    };

export async function loadReader(source: DocSource, opts: { doc?: string; sourceRepo: string }): Promise<ReaderView> {
  try {
    const listing = await source.listDocs();
    const config = listing.owners?.ok ? listing.owners.config : undefined;
    const view: ReaderView = {
      status: "ok",
      mode: source.mode,
      tree: buildTree(listing.entries),
      docCount: listing.entries.filter((e) => e.kind === "doc").length,
      paths: {
        docs: listing.entries.filter((e) => e.kind === "doc").map((e) => e.path),
        images: listing.entries.filter((e) => e.kind === "image").map((e) => e.path),
      },
      ...(listing.owners && !listing.owners.ok ? { ownersError: listing.owners.error } : {}),
    };
    if (opts.doc) {
      try {
        const markdown = await source.readDoc(opts.doc);
        view.doc = {
          missing: false,
          path: opts.doc,
          title: titleOf(opts.doc, markdown),
          markdown,
          owner: ownerOf(opts.doc, { config, markdown, fallbackRepo: opts.sourceRepo }),
          headings: headingsOf(markdown),
          breadcrumb: breadcrumbOf(opts.doc),
          stats: statsOf(markdown),
          issueLinks: issueLinksBySection(markdown),
        };
      } catch (err) {
        if (!(err instanceof DocNotFoundError)) throw err;
        view.doc = { missing: true, path: opts.doc };
      }
    }
    return view;
  } catch (err) {
    if (err instanceof SourceUnavailableError) return { status: "unavailable", reason: err.message };
    throw err;
  }
}
