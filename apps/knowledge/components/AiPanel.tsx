"use client";
/**
 * AI writing assistance in the editor (#360): outline from a brief, improve the selection, summary and metadata,
 * and a Mermaid diagram from a description. Each answer is a PROPOSAL shown here first; the author applies it to
 * the editor (or discards it), then saves as usual. Nothing is saved or published by the AI, and an AI failure
 * leaves the draft exactly as it was.
 */
import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { aiAction } from "@/app/studio/ai-actions";
import type { Proposal } from "@/lib/ai/operations";
import { ERRORS } from "@/lib/messages";

type Op = "outline" | "improve" | "summary" | "mermaid";

const LABEL: Record<Op, string> = {
  outline: "Outline from a brief",
  improve: "Improve the selection",
  summary: "Summary and metadata",
  mermaid: "Diagram from a description",
};

export interface AiPanelProps {
  editor: Editor;
  itemId: string;
  baseRevisionId: string;
  title: string;
  onSummary: (summary: string) => void;
  onTitle: (title: string) => void;
}

export function AiPanel({ editor, itemId, baseRevisionId, title, onSummary, onTitle }: AiPanelProps) {
  const [op, setOp] = useState<Op>("outline");
  const [brief, setBrief] = useState("");
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stored, setProposal] = useState<{
    value: Proposal;
    revision: string;
    doc: Editor["state"]["doc"];
    range?: { from: number; to: number };
    /** The spaces at the selection's edges, which the trimmed proposal must keep so words don't join. */
    edges?: { lead: string; trail: string };
  } | null>(null);
  const proposal = stored?.revision === baseRevisionId ? stored.value : null;

  const selectedText = () => {
    const { from, to } = editor.state.selection;
    return { from, to, text: editor.state.doc.textBetween(from, to, "\n\n") };
  };

  async function ask() {
    setError(null);
    setProposal(null);
    const doc = editor.state.doc;
    let range: { from: number; to: number } | undefined;
    let edges: { lead: string; trail: string } | undefined;
    let input: Record<string, unknown>;
    if (op === "outline") input = { op, brief, title };
    else if (op === "mermaid") input = { op, description: brief };
    else if (op === "summary") input = { op, title, text: editor.getText({ blockSeparator: "\n\n" }) };
    else {
      const sel = selectedText();
      if (!sel.text.trim()) return setError("ai_input_empty");
      range = { from: sel.from, to: sel.to };
      edges = { lead: /^[ \t]*/.exec(sel.text)![0], trail: /[ \t]*$/.exec(sel.text)![0] };
      input = { op, selection: sel.text, instruction };
    }
    setPending(true);
    try {
      const r = await aiAction({ itemId, baseRevisionId, input });
      if (r.ok) setProposal({ value: r.proposal, revision: baseRevisionId, doc, range, edges });
      else setError(r.error);
    } catch {
      setError("ai_unavailable");
    } finally {
      setPending(false);
    }
  }

  function isCurrent() {
    if (proposal && stored?.doc.eq(editor.state.doc)) return true;
    setProposal(null);
    setError("ai_stale_proposal");
    return false;
  }

  function apply() {
    if (!proposal || !isCurrent()) return;
    const range = stored?.range;
    const edges = stored?.edges ?? { lead: "", trail: "" };
    const chain = editor.chain().focus();
    if (proposal.kind === "outline") chain.insertContent(proposal.doc.content).run();
    else if (proposal.kind === "mermaid")
      chain.insertMermaid({ source: proposal.source, description: proposal.description }).run();
    else if (proposal.kind === "text" && range) {
      const parts = proposal.text.split(/\n{2,}/);
      parts[0] = edges.lead + parts[0];
      parts[parts.length - 1] += edges.trail;
      const paragraphs = parts.map((p) => ({
        type: "paragraph",
        content: p ? [{ type: "text", text: p.replace(/\n/g, " ") }] : [],
      }));
      chain.insertContentAt(range, paragraphs.length === 1 ? paragraphs[0]!.content : paragraphs).run();
    }
    setProposal(null);
  }

  return (
    <section className="ai-panel" aria-label="AI assistance" data-testid="ai-panel">
      <div className="ai-head">
        <strong>AI assistance</strong>
        <span className="muted">Proposals only: you review them, apply them, then save.</span>
      </div>
      <div className="ai-ops" role="radiogroup" aria-label="What to ask">
        {(Object.keys(LABEL) as Op[]).map((o) => (
          <label key={o} className={o === op ? "ai-op active" : "ai-op"}>
            <input
              type="radio"
              name="ai-op"
              value={o}
              checked={o === op}
              onChange={() => {
                setOp(o);
                setProposal(null);
                setError(null);
              }}
            />
            {LABEL[o]}
          </label>
        ))}
      </div>
      {op === "outline" || op === "mermaid" ? (
        <label>
          {op === "outline" ? "Brief: what the article should cover" : "Describe the diagram"}
          <textarea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} data-testid="ai-brief" />
        </label>
      ) : op === "improve" ? (
        <label>
          How to improve the selected text (optional)
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. shorter, friendlier, explain the jargon"
            data-testid="ai-instruction"
          />
        </label>
      ) : (
        <p className="muted">Uses the whole body to propose a summary, titles and tags.</p>
      )}
      <button type="button" className="secondary" onClick={ask} disabled={pending} data-testid="ai-ask">
        {pending ? "Asking…" : "Ask the AI"}
      </button>
      {error ? (
        <p className="notice bad" role="alert" data-testid="ai-error">
          {ERRORS[error] ?? error}
        </p>
      ) : null}
      {proposal ? (
        <div className="ai-proposal" data-testid="ai-proposal">
          <strong>Proposal</strong>
          {proposal.kind === "outline" ? (
            <ul>
              {proposal.doc.content
                .filter((n) => n.type === "heading")
                .map((n, i) => (
                  <li key={i}>{(n.content ?? []).map((c) => c.text).join("")}</li>
                ))}
            </ul>
          ) : proposal.kind === "text" ? (
            <p className="ai-text">{proposal.text}</p>
          ) : proposal.kind === "mermaid" ? (
            <pre className="diagram-source">{proposal.source}</pre>
          ) : (
            <div>
              <p>{proposal.summary}</p>
              {proposal.tags.length ? <p className="muted">Tags: {proposal.tags.join(", ")}</p> : null}
            </div>
          )}
          <div className="ai-actions">
            {proposal.kind === "metadata" ? (
              <>
                <button
                  type="button"
                  onClick={() => isCurrent() && onSummary(proposal.summary)}
                  data-testid="ai-use-summary"
                >
                  Use as summary
                </button>
                {proposal.titles.map((t) => (
                  <button type="button" key={t} className="secondary" onClick={() => isCurrent() && onTitle(t)}>
                    Title: {t}
                  </button>
                ))}
              </>
            ) : (
              <button type="button" onClick={apply} data-testid="ai-apply">
                {proposal.kind === "text" ? "Replace the selection" : "Insert at the cursor"}
              </button>
            )}
            <button type="button" className="secondary" onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
