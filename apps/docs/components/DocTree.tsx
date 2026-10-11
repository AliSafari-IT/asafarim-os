"use client";
/**
 * The documents on the left (#80): folders with readable names, a filter box that keeps the matching
 * documents and the folders above them, and the open document marked as the current page.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { docHref, fileHref } from "@/lib/links";
import type { NavNode } from "./nav";

function matches(node: NavNode, q: string): boolean {
  return `${node.label} ${node.path ?? ""}`.toLowerCase().includes(q);
}

/** The tree with only what matches `q` (a folder stays when anything inside it does). */
export function filterTree(nodes: NavNode[], q: string): NavNode[] {
  if (!q) return nodes;
  const out: NavNode[] = [];
  for (const n of nodes) {
    if (n.path) {
      if (matches(n, q)) out.push(n);
      continue;
    }
    const children = matches(n, q) ? n.children : filterTree(n.children, q);
    if (children.length) out.push({ ...n, children });
  }
  return out;
}

function Branch({ nodes, selected, onOpen }: { nodes: NavNode[]; selected?: string; onOpen?: () => void }) {
  return (
    <ul>
      {nodes.map((n, i) =>
        n.path ? (
          <li key={n.path}>
            {n.kind === "doc" ? (
              <Link
                href={docHref(n.path)}
                aria-current={n.path === selected ? "page" : undefined}
                data-testid={`doc-${n.path}`}
                onClick={onOpen}
              >
                {n.label}
              </Link>
            ) : (
              <a href={fileHref(n.path)} className="file">
                {n.label}
              </a>
            )}
          </li>
        ) : (
          <li key={`dir:${i}:${n.label}`} className="folder">
            <details open>
              <summary>{n.label}</summary>
              <Branch nodes={n.children} selected={selected} onOpen={onOpen} />
            </details>
          </li>
        ),
      )}
    </ul>
  );
}

export function DocTree({ nodes, selected, onOpen }: { nodes: NavNode[]; selected?: string; onOpen?: () => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => filterTree(nodes, q), [nodes, q]);
  return (
    <>
      <label className="filter">
        <span className="visually-hidden">Filter documents</span>
        <input
          type="search"
          placeholder="Filter documents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="tree-filter"
        />
      </label>
      {shown.length ? (
        // A filtered tree is re-mounted, so every folder on the way to a match is open.
        <Branch key={q} nodes={shown} selected={selected} onOpen={onOpen} />
      ) : (
        <p className="muted" data-testid="tree-empty">
          {q ? "No document matches." : "No documents yet."}
        </p>
      )}
    </>
  );
}
