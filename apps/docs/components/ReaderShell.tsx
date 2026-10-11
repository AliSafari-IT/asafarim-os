"use client";
/**
 * The three columns (#80): documents, the open document, "On this page". On a phone the documents
 * become a drawer behind a "Documents" button; picking one or pressing Escape closes it.
 */
import { useEffect, useState } from "react";
import { DocTree } from "./DocTree";
import type { NavNode } from "./nav";

export function ReaderShell({
  nodes,
  selected,
  children,
  toc,
}: {
  nodes: NavNode[];
  selected?: string;
  children: React.ReactNode;
  toc: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="reader" data-testid="reader" data-drawer={open ? "open" : "closed"}>
      <button
        type="button"
        className="secondary drawer-toggle"
        aria-expanded={open}
        aria-controls="documents"
        onClick={() => setOpen((o) => !o)}
        data-testid="drawer-toggle"
      >
        Documents
      </button>
      <nav id="documents" className="tree" aria-label="Documents">
        <h2>Documents</h2>
        <DocTree nodes={nodes} selected={selected} onOpen={() => setOpen(false)} />
      </nav>
      {open ? <div className="scrim" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
      {children}
      <aside className="toc" aria-label="On this page">
        <h2>On this page</h2>
        {toc}
      </aside>
    </div>
  );
}
