/**
 * The home page and the previous / next links: worked out from the tree alone, so nothing more is fetched from the
 * source repository. Labels are the readable file and folder names the sidebar shows.
 */
import { readableName } from "./outline";
import type { TreeNode } from "./reader";

export interface DocLink {
  label: string;
  path: string;
  /** The folder it is in, made readable, when that isn't the section itself: "Demo App" for two "Overview"s. */
  where?: string;
}

export interface HomeSection {
  /** A top-level folder, made readable. */
  label: string;
  /** Every document in it, at any depth. */
  count: number;
  /** The first few, in sidebar order. */
  docs: DocLink[];
  /** How many more there are. */
  more: number;
}

export interface HomeView {
  /** `index.md` (else `README.md`) at the root: where a reader starts. */
  start?: DocLink;
  /** One card per top-level folder, in sidebar order. */
  sections: HomeSection[];
  /** The other documents at the root, if any. */
  loose: DocLink[];
}

/** How many documents a section card lists before "N more". */
export const SECTION_PREVIEW = 4;

const linkOf = (node: TreeNode, where?: string): DocLink => ({
  label: readableName(node.name),
  path: node.entry!.path,
  ...(where ? { where } : {}),
});
const isDoc = (node: TreeNode) => node.entry?.kind === "doc";

/** Every document under `nodes`, depth first, in the sidebar's order. `where` is the folder `nodes` are in. */
export function docsInOrder(nodes: TreeNode[], where?: string): DocLink[] {
  const out: DocLink[] = [];
  for (const n of nodes) {
    if (isDoc(n)) out.push(linkOf(n, where));
    else if (!n.entry) out.push(...docsInOrder(n.children, readableName(n.name)));
  }
  return out;
}

export function homeOf(tree: TreeNode[]): HomeView {
  const rootDocs = tree.filter(isDoc);
  const startNode =
    rootDocs.find((n) => /^index\.md$/i.test(n.name)) ?? rootDocs.find((n) => /^readme\.md$/i.test(n.name));
  const sections: HomeSection[] = [];
  for (const folder of tree.filter((n) => !n.entry)) {
    const docs = docsInOrder(folder.children);
    if (!docs.length) continue;
    sections.push({
      label: readableName(folder.name),
      count: docs.length,
      docs: docs.slice(0, SECTION_PREVIEW),
      more: Math.max(0, docs.length - SECTION_PREVIEW),
    });
  }
  return {
    ...(startNode ? { start: linkOf(startNode) } : {}),
    sections,
    loose: rootDocs.filter((n) => n !== startNode).map((n) => linkOf(n)),
  };
}

/** The documents before and after `path` in the sidebar's order (none at either end, or for an unknown path). */
export function neighboursOf(tree: TreeNode[], path: string): { prev?: DocLink; next?: DocLink } {
  const all = docsInOrder(tree);
  const i = all.findIndex((d) => d.path === path);
  if (i < 0) return {};
  const prev = all[i - 1];
  const next = all[i + 1];
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}
