"use client";
/**
 * Study notes on the open document (#81). Select text (or point at a heading) and "Add note": a
 * private note anchored by the heading id and the quoted text. Notes show as highlights in the text
 * and in the "Notes" list under the document; a note whose text was edited away stays, under its
 * heading, marked "text changed".
 *
 * Highlights use the CSS Custom Highlight API over the rendered page: text nodes only, nothing is
 * re-parsed or inserted, so the server-rendered document is never touched. A quote that occurs more
 * than once is highlighted at its first match after its heading.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { findQuote } from "@/lib/quote";
import { IssueDialog } from "./IssueDialog";
import { IssueLink } from "./IssueLink";

export interface NoteView {
  id: string;
  /** The section it shows under (where its quote is now); "" is the top of the document. */
  headingId: string;
  headingTitle: string;
  quote: string;
  /** The Markdown, for editing. */
  body: string;
  status: "ok" | "changed";
  updatedAt: string;
  /** The GitHub issue made from this note (#82). */
  issueUrl: string | null;
  /** Flow created that issue from an approved draft (ADR 0001). */
  viaFlow: boolean;
  /** The body, rendered on the server (sanitized). */
  rendered: React.ReactNode;
}

const HEADINGS = "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]";
const BLOCKS = "p, li, td, th, h1, h2, h3, h4, h5, h6, pre, blockquote, dt, dd, figcaption";
const ISSUES_NOT_SET_UP = "Not set up yet: the server needs DOCS_AI_API_KEY and DOCS_ISSUES_TOKEN.";
const MAX_QUOTE = 1000;

/** The document's text nodes in order, as a reader sees them: no heading anchors, no drawn charts. */
export function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(".anchor, [data-testid='mermaid'], svg, script, style")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** The text a selection covers, from the same text nodes the highlights use (blocks apart by a space). */
function quoteOf(range: Range, nodes: Text[]): string {
  let out = "";
  let block: Element | null | undefined;
  for (const t of nodes) {
    if (!range.intersectsNode(t)) continue;
    const start = t === range.startContainer ? range.startOffset : 0;
    const end = t === range.endContainer ? range.endOffset : t.data.length;
    const here = t.parentElement?.closest(BLOCKS);
    if (block !== undefined && here !== block) out += " ";
    out += t.data.slice(start, end);
    block = here;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The heading a point of the document is under: the last one that starts before it. */
function headingBefore(root: HTMLElement, node: Node): HTMLElement | undefined {
  let found: HTMLElement | undefined;
  for (const h of Array.from(root.querySelectorAll<HTMLElement>(HEADINGS))) {
    if (h.contains(node) || h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found;
}

const highlights = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : undefined;

/** Who may turn notes into issues (docs.issues.create), and whether the server has the secrets for it. */
export interface IssuesState {
  allowed: boolean;
  ready: boolean;
}

/**
 * `pick`: the note's place is chosen in the dialog (the "Add a note" button), not given by the page.
 * `issue`: "Generate GitHub issue" on a selection or heading: save the note, then open the preview.
 */
type NewDraft = { kind: "new"; headingId: string; quote: string; pick?: boolean; issue?: boolean };
type Draft = NewDraft | { kind: "edit"; note: NoteView };
type Spot = { top: number; left: number };

export function Notes({
  docPath,
  headings,
  notes,
  canWrite,
  available,
  issues,
  children,
}: {
  docPath: string;
  headings: { id: string; title: string }[];
  notes: NoteView[];
  canWrite: boolean;
  available: boolean;
  issues: IssuesState;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const ranges = useRef(new Map<string, Range>());
  const [selection, setSelection] = useState<(Spot & { headingId: string; quote: string }) | null>(null);
  const [hovered, setHovered] = useState<{ top: number; headingId: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<NoteView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [issueFor, setIssueFor] = useState<{ id: string; issueUrl: string | null } | null>(null);
  const writable = canWrite && available;

  // Highlights: each note's quote, at its first match after its heading.
  useEffect(() => {
    const root = body.current;
    const registry = highlights();
    if (!root) return;
    const nodes = textNodes(root);
    const texts = nodes.map((t) => t.data);
    const found = new Map<string, Range>();
    for (const n of notes) {
      if (n.status !== "ok" || !n.quote) continue;
      const heading = n.headingId ? document.getElementById(n.headingId) : null;
      const from = heading
        ? nodes.findIndex(
            (t) => heading.contains(t) || heading.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : 0;
      const hit = findQuote(texts, n.quote, Math.max(0, from));
      if (!hit) continue;
      const range = document.createRange();
      range.setStart(nodes[hit[0].segment]!, hit[0].offset);
      range.setEnd(nodes[hit[1].segment]!, hit[1].offset);
      found.set(n.id, range);
    }
    ranges.current = found;
    root.dataset.highlights = String(found.size);
    registry?.set("doc-notes", new Highlight(...found.values()));
    return () => {
      registry?.delete("doc-notes");
      registry?.delete("doc-note-active");
    };
  }, [notes]);

  const spotOf = (rect: DOMRect): Spot => {
    const box = wrap.current!.getBoundingClientRect();
    return { top: rect.bottom - box.top + 6, left: Math.max(0, Math.min(rect.left - box.left, box.width - 300)) };
  };

  /** After a mouse or keyboard selection: offer "Add note" for it; a plain click on a highlight shows its note. */
  const onSelect = useCallback(() => {
    // The selection settles after the event.
    setTimeout(() => {
      const root = body.current;
      const sel = document.getSelection();
      if (!root || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (sel.isCollapsed) {
        setSelection(null);
        for (const [id, r] of ranges.current) {
          if (sel.anchorNode && r.isPointInRange(sel.anchorNode, sel.anchorOffset)) {
            const el = document.getElementById(`note-${id}`);
            el?.scrollIntoView({ block: "nearest" });
            el?.focus({ preventScroll: true });
            break;
          }
        }
        return;
      }
      if (!writable || !root.contains(range.commonAncestorContainer)) return setSelection(null);
      const quote = quoteOf(range, textNodes(root));
      if (!quote) return setSelection(null);
      const heading = headingBefore(root, range.startContainer);
      setSelection({ ...spotOf(range.getBoundingClientRect()), headingId: heading?.id ?? "", quote });
    }, 0);
  }, [writable]);

  useEffect(() => {
    // A selection that goes away takes its "Add note" with it.
    const onChange = () => {
      if (document.getSelection()?.isCollapsed) setSelection(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelection(null);
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const onHover = (e: React.MouseEvent) => {
    if (!writable) return;
    const target = e.target as Element;
    if (target.closest(".heading-tools")) return;
    const h = target.closest<HTMLElement>(HEADINGS);
    if (!h || !body.current?.contains(h)) return setHovered(null);
    const box = wrap.current!.getBoundingClientRect();
    setHovered({ top: h.getBoundingClientRect().top - box.top, headingId: h.id });
  };

  const open = (d: Draft) => {
    setDraft(d);
    setError("");
    setSelection(null);
    setHovered(null);
    // The dialog is rendered with the draft; open it once it is.
    requestAnimationFrame(() => editor.current?.showModal());
  };

  const done = () => {
    editor.current?.close();
    confirm.current?.close();
    setDraft(null);
    setRemoving(null);
    router.refresh();
  };

  /** The answer's JSON (`{}` for none) when it succeeded; null (and the error shown) when it didn't. */
  async function send(url: string, method: string, payload?: unknown): Promise<{ body: unknown } | null> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, {
        method,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (res.ok) return { body: (await res.json().catch(() => null)) ?? {} };
      const answer = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(answer?.message ?? `The note couldn't be saved (${res.status}).`);
      return null;
    } catch {
      setError("The note couldn't be saved: the app isn't reachable.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft) return;
    const form = new FormData(e.currentTarget);
    const text = String(form.get("body") ?? "");
    const saved =
      draft.kind === "edit"
        ? await send(`/api/notes/${draft.note.id}`, "PATCH", { body: text })
        : await send("/api/notes", "POST", {
            docPath,
            headingId: draft.pick ? String(form.get("heading") ?? "") : draft.headingId,
            quote: draft.quote,
            body: text,
          });
    if (!saved) return;
    const thenIssue = draft.kind === "new" && draft.issue;
    done();
    // "Generate GitHub issue" on a selection or heading: the note is saved, now the preview.
    const id = (saved.body as { note?: { id?: unknown } }).note?.id;
    if (thenIssue && typeof id === "string") setIssueFor({ id, issueUrl: null });
  }

  async function remove() {
    if (removing && (await send(`/api/notes/${removing.id}`, "DELETE"))) done();
  }

  /** "Show in the text": scroll to the note's highlight and mark it. */
  const show = (id: string) => {
    const range = ranges.current.get(id);
    if (!range) return;
    highlights()?.set("doc-note-active", new Highlight(range));
    const rect = range.getBoundingClientRect();
    window.scrollBy({ top: rect.top - window.innerHeight / 3 });
  };

  const titleOf = (id: string) => headings.find((h) => h.id === id)?.title ?? "";
  const draftQuote = draft?.kind === "new" ? draft.quote : draft?.note.quote;
  const draftHeading = draft?.kind === "new" ? draft.headingId : draft?.note.headingId;

  return (
    <>
      <div className="prose-wrap" ref={wrap} onMouseOver={onHover} onMouseLeave={() => setHovered(null)}>
        <div className="prose" data-testid="doc-body" ref={body} onMouseUp={onSelect} onKeyUp={onSelect}>
          {children}
        </div>
        {hovered ? (
          <div className="heading-tools" style={{ top: hovered.top }} data-testid="heading-tools">
            <button
              type="button"
              className="secondary small"
              onClick={() => open({ kind: "new", headingId: hovered.headingId, quote: "" })}
            >
              Add note
            </button>
            <IssueButton
              issues={issues}
              onClick={() => open({ kind: "new", headingId: hovered.headingId, quote: "", issue: true })}
            />
          </div>
        ) : null}
        {selection ? (
          <div
            className="selection-tools"
            role="toolbar"
            aria-label="Selected text"
            style={{ top: selection.top, left: selection.left }}
            data-testid="selection-tools"
            // Keep the selection while a button is pressed.
            onMouseDown={(e) => e.preventDefault()}
          >
            <button type="button" className="small" onClick={() => open({ kind: "new", ...selection })}>
              Add note
            </button>
            <IssueButton issues={issues} onClick={() => open({ kind: "new", ...selection, issue: true })} />
          </div>
        ) : null}
      </div>

      <section className="notes" aria-labelledby="notes-title" data-testid="notes">
        <div className="notes-head">
          <h2 id="notes-title">
            Notes <span className="muted">({notes.length})</span>
          </h2>
          {writable ? (
            <button
              type="button"
              className="secondary small"
              data-testid="add-note"
              onClick={() => open({ kind: "new", headingId: "", quote: "", pick: true })}
            >
              Add a note
            </button>
          ) : null}
        </div>
        {!available ? (
          <p className="muted" data-testid="notes-unavailable">
            Notes aren&apos;t available right now.
          </p>
        ) : notes.length === 0 ? (
          <p className="muted">
            No notes on this document yet.
            {writable ? " Select some text, or point at a heading, to add one." : null}
          </p>
        ) : (
          <ol className="note-list">
            {notes.map((n) => (
              <li key={n.id}>
                <article
                  id={`note-${n.id}`}
                  className="note"
                  tabIndex={-1}
                  aria-labelledby={`note-${n.id}-where`}
                  data-testid="note"
                  data-status={n.status}
                >
                  <p className="note-where" id={`note-${n.id}-where`}>
                    {n.headingId ? (
                      <a href={`#${encodeURIComponent(n.headingId)}`}>{n.headingTitle || n.headingId}</a>
                    ) : (
                      "The whole document"
                    )}
                    {n.status === "changed" ? (
                      <span
                        className="badge warn"
                        data-testid="text-changed"
                        title="The document changed: the text this note quoted isn't in it any more."
                      >
                        text changed
                      </span>
                    ) : null}
                  </p>
                  {n.quote ? (
                    <blockquote className="note-quote">
                      {n.quote}
                      {n.status === "ok" ? (
                        <>
                          {" "}
                          <button type="button" className="link" onClick={() => show(n.id)}>
                            Show in the text
                          </button>
                        </>
                      ) : null}
                    </blockquote>
                  ) : null}
                  <div className="note-body">{n.rendered}</div>
                  <p className="note-foot muted">
                    <span>{n.updatedAt.slice(0, 10)}</span>
                    <IssueLink url={n.issueUrl} viaFlow={n.viaFlow} />
                    <IssueButton
                      issues={issues}
                      className="link"
                      onClick={() => setIssueFor({ id: n.id, issueUrl: n.issueUrl })}
                    />
                    {writable ? (
                      <>
                        <button type="button" className="link" onClick={() => open({ kind: "edit", note: n })}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="link danger"
                          onClick={() => {
                            setRemoving(n);
                            setError("");
                            requestAnimationFrame(() => confirm.current?.showModal());
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </p>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>

      <dialog ref={editor} className="note-editor" aria-labelledby="note-editor-title" onClose={() => setDraft(null)}>
        {draft ? (
          <form onSubmit={save}>
            <h2 id="note-editor-title">{draft.kind === "edit" ? "Edit note" : "Add a note"}</h2>
            {draft.kind === "edit" || !draft.pick ? (
              <p className="muted">
                On <strong>{draftHeading ? titleOf(draftHeading) || draftHeading : "the whole document"}</strong>
              </p>
            ) : (
              <label>
                On
                <select name="heading" defaultValue={draftHeading}>
                  <option value="">The whole document</option>
                  {headings.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draftQuote ? <blockquote className="note-quote">{draftQuote.slice(0, MAX_QUOTE)}</blockquote> : null}
            <label>
              Note <span className="muted">(Markdown)</span>
              <textarea
                name="body"
                rows={6}
                required
                maxLength={10000}
                defaultValue={draft.kind === "edit" ? draft.note.body : ""}
              />
            </label>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="actions">
              <button type="button" className="secondary" onClick={() => editor.current?.close()}>
                Cancel
              </button>
              <button type="submit" disabled={busy}>
                {draft.kind === "new" && draft.issue ? "Save note and generate issue" : "Save note"}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>

      <dialog
        ref={confirm}
        className="note-editor"
        aria-labelledby="note-delete-title"
        onClose={() => setRemoving(null)}
      >
        <h2 id="note-delete-title">Delete this note?</h2>
        <p>It can&apos;t be brought back.</p>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="secondary" onClick={() => confirm.current?.close()}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
      </dialog>

      {issueFor ? (
        <IssueDialog
          key={issueFor.id}
          noteId={issueFor.id}
          issueUrl={issueFor.issueUrl}
          onClose={() => setIssueFor(null)}
          onCreated={() => {
            setIssueFor(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Generate GitHub issue", on a note or by a selection or heading (which writes the note first).
 * Hidden without docs.issues.create; shown but disabled until the server has its secrets.
 */
function IssueButton({
  issues,
  onClick,
  className = "secondary small",
}: {
  issues: IssuesState;
  onClick: () => void;
  className?: string;
}) {
  if (!issues.allowed) return null;
  if (!issues.ready) {
    return (
      <button
        type="button"
        className={className}
        aria-disabled="true"
        title={ISSUES_NOT_SET_UP}
        onClick={(e) => e.preventDefault()}
      >
        Generate GitHub issue
      </button>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      Generate GitHub issue
    </button>
  );
}
