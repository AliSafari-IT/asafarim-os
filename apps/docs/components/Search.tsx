"use client";
/**
 * ⌘K / Ctrl+K (#80): search the titles and headings of every document. The index is fetched from
 * /api/search (gated) the first time the dialog opens. Arrow keys move, Enter opens, Escape closes.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { docHref } from "@/lib/links";

interface Entry {
  path: string;
  title: string;
  crumbs: string[];
  headings: { text: string; id: string }[];
}

export interface Hit {
  path: string;
  hash: string;
  label: string;
  context: string;
}

/** Titles before headings, and a match at the start of a word before one inside it. */
export function searchDocs(docs: Entry[], query: string, limit = 20): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { hit: Hit; score: number }[] = [];
  const score = (text: string, base: number) => {
    const t = text.toLowerCase();
    const i = t.indexOf(q);
    if (i < 0) return -1;
    return base + (i === 0 ? 2 : /\W/.test(t[i - 1] ?? "") ? 1 : 0);
  };
  for (const d of docs) {
    const where = [...d.crumbs].join(" › ");
    const s = Math.max(score(d.title, 10), score(d.path, 5));
    if (s >= 0) scored.push({ hit: { path: d.path, hash: "", label: d.title, context: where }, score: s });
    for (const h of d.headings) {
      const hs = score(h.text, 0);
      if (hs >= 0) scored.push({ hit: { path: d.path, hash: `#${h.id}`, label: h.text, context: d.title }, score: hs });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.hit.label.localeCompare(b.hit.label))
    .slice(0, limit)
    .map((s) => s.hit);
}

export function Search() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [docs, setDocs] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const hits = useMemo(() => (docs ? searchDocs(docs, query) : []), [docs, query]);

  const open = useCallback(() => {
    dialog.current?.showModal();
    input.current?.select();
    if (docs) return;
    // A failed load is tried again the next time the dialog opens.
    setError(false);
    fetch("/api/search", { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setDocs(((await res.json()) as { docs: Entry[] }).docs);
      })
      .catch(() => setError(true));
  }, [docs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  function go(hit: Hit | undefined) {
    if (!hit) return;
    dialog.current?.close();
    router.push(docHref(hit.path, hit.hash));
  }

  return (
    <>
      <button type="button" className="secondary search-button" onClick={open} data-testid="search-open">
        Search <kbd>⌘K</kbd>
      </button>
      <dialog ref={dialog} className="search" aria-label="Search the documents" onClose={() => setQuery("")}>
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={hits[cursor] ? `${listId}-${cursor}` : undefined}
          aria-label="Search titles and headings"
          placeholder="Search titles and headings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, hits.length - 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter") go(hits[cursor]);
            else return;
            e.preventDefault();
          }}
          data-testid="search-input"
        />
        <ul id={listId} role="listbox" aria-label="Results" data-testid="search-results">
          {hits.map((h, i) => (
            <li
              key={`${h.path}${h.hash}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(h)}
            >
              <span className="hit">{h.label}</span>
              <span className="muted context">{h.context}</span>
            </li>
          ))}
        </ul>
        <p className="muted hint" role="status">
          {error
            ? "Search isn't available right now."
            : !docs
              ? "Loading…"
              : query.trim() && !hits.length
                ? "Nothing matches."
                : "↑ ↓ to move, Enter to open, Esc to close."}
        </p>
      </dialog>
    </>
  );
}
