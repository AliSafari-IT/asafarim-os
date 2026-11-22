"use client";
/**
 * A Mermaid diagram (#360), drawn in the browser with `securityLevel: "strict"` (labels sanitised, no click
 * handlers, no scripts), HTML labels off, and Mermaid's own size limit. The source was already checked by
 * lib/doc.ts (no directives, interactions or HTML). Mermaid is a large library, so it loads only when a page has a
 * diagram. Until it is drawn, or if it can't be, the source stays visible; the text description is always there
 * for readers who can't see the picture.
 */
import type mermaidDefault from "mermaid";
import { useEffect, useId, useState } from "react";
import { checkMermaid, LIMITS } from "@/lib/doc";

type MermaidApi = typeof mermaidDefault;
let ready: Promise<MermaidApi> | null = null;
const dark = () => {
  const picked = document.documentElement.dataset.theme;
  return picked ? picked === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};

async function mermaid() {
  ready ??= import("mermaid").then((m) => m.default);
  const mm = await ready;
  mm.initialize({
    suppressErrorRendering: true,
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark() ? "dark" : "default",
    maxTextSize: LIMITS.mermaid,
    maxEdges: 200,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels"],
  });
  return mm;
}

export function MermaidDiagram({ source, description }: { source: string; description: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    const checked = checkMermaid(source);
    if (!checked.ok) {
      setFailed(true);
      return;
    }
    (async () => {
      try {
        const mm = await mermaid();
        const out = await mm.render(`${id}-${Date.now()}`, checked.source);
        if (!cancelled) setSvg(out.svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  return (
    <figure className="diagram" data-testid="diagram">
      {svg ? (
        // Mermaid's own output in strict mode, from a checked source: the one HTML string this page inserts.
        <div
          className="diagram-svg"
          role="img"
          aria-label={description || "Diagram"}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="diagram-source" aria-label={failed ? "Diagram source (couldn't be drawn)" : "Diagram source"}>
          {source}
        </pre>
      )}
      {failed ? <p className="muted">This diagram couldn&apos;t be drawn; its source is shown instead.</p> : null}
      {description ? <figcaption>{description}</figcaption> : null}
    </figure>
  );
}
