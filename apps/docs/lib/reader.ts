/**
 * What the reading page shows (#78): the tree, and the selected document with the repository that
 * owns it. Kept apart from the page so it can be tested without Next.js.
 */
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

/** The document's title: its first `# ` heading after any front matter, else the file name. */
export function titleOf(docPath: string, markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return h1 ? h1[1]! : docPath.split("/").at(-1)!.replace(/\.md$/i, "");
}

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
      /** docs-app.json couldn't be used: shown, and every document falls back to the source repo. */
      ownersError?: string;
      doc?:
        | { missing: false; path: string; title: string; markdown: string; owner: Owner }
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
