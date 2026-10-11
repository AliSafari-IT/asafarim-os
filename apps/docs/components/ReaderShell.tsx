"use client";
/**
 * The three columns (#80): documents, the open document, "On this page". On a phone the documents
 * become a drawer behind a "Documents" button: focus moves into it and the rest of the page is inert
 * while it's open; picking a document, Escape or the scrim closes it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  const nav = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // Closing with Escape or the scrim puts focus back on the button; picking a document navigates.
  const close = useCallback((back: boolean) => {
    refocus.current = back;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open || !nav.current) return;
    // While the drawer is open, everything else on the page is inert: focus stays in the drawer.
    const inert: HTMLElement[] = [];
    for (let el: HTMLElement | null = nav.current; el && el !== document.body; el = el.parentElement) {
      for (const sibling of Array.from(el.parentElement?.children ?? [])) {
        if (
          sibling !== el &&
          sibling instanceof HTMLElement &&
          !sibling.inert &&
          !sibling.classList.contains("scrim")
        ) {
          sibling.inert = true;
          inert.push(sibling);
        }
      }
    }
    nav.current.querySelector<HTMLElement>("input, a")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    window.addEventListener("keydown", onKey);
    return () => {
      for (const el of inert) el.inert = false;
      window.removeEventListener("keydown", onKey);
      // Only now is the button focusable again.
      if (refocus.current) toggle.current?.focus();
      refocus.current = false;
    };
  }, [open, close]);

  return (
    <div className="reader" data-testid="reader" data-drawer={open ? "open" : "closed"}>
      <button
        type="button"
        ref={toggle}
        className="secondary drawer-toggle"
        aria-expanded={open}
        aria-controls="documents"
        onClick={() => setOpen((o) => !o)}
        data-testid="drawer-toggle"
      >
        Documents
      </button>
      <nav ref={nav} id="documents" className="tree" aria-label="Documents">
        <h2>Documents</h2>
        <DocTree nodes={nodes} selected={selected} onOpen={() => close(false)} />
      </nav>
      {open ? <div className="scrim" aria-hidden="true" onClick={() => close(true)} /> : null}
      {children}
      <aside className="toc" aria-label="On this page">
        <h2>On this page</h2>
        {toc}
      </aside>
    </div>
  );
}
