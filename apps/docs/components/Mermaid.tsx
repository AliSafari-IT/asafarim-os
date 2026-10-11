"use client";
/**
 * A Mermaid diagram (#80), drawn in the browser. `mermaid` is a large library, so it's imported only
 * when a document has a diagram, with `securityLevel: "strict"` (no script, no click handlers, labels
 * sanitized). Until it's drawn, or if it can't be, the source stays visible.
 */
import { useEffect, useId, useRef, useState } from "react";

const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** What a screen reader hears: the diagram's own `title`, if it has one. */
export const mermaidLabel = (source: string) => {
  const title = /^\s*title\s+(.+?)\s*$/m.exec(source)?.[1];
  return title ? `Diagram: ${title}` : "Diagram";
};

export function Mermaid({ source, children }: { source: string; children: React.ReactNode }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"source" | "drawn" | "failed">("source");

  useEffect(() => {
    let cancelled = false;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    async function draw() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "default" });
        const { svg } = await mermaid.render(id, source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        setState("drawn");
      } catch {
        if (!cancelled) setState("failed");
      }
    }
    void draw();
    media.addEventListener("change", draw);
    return () => {
      cancelled = true;
      media.removeEventListener("change", draw);
    };
  }, [id, source]);

  return (
    <figure className="mermaid" data-state={state} data-testid="mermaid">
      <div ref={ref} className="mermaid-svg" role="img" aria-label={mermaidLabel(source)} hidden={state !== "drawn"} />
      {state !== "drawn" ? children : null}
      {state === "failed" ? <figcaption className="muted">This diagram can&apos;t be drawn.</figcaption> : null}
    </figure>
  );
}
