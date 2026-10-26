"use client";
/**
 * A Mermaid diagram (#80), drawn in the browser. `mermaid` is a large library, so it's imported only
 * when a document has a diagram, with `securityLevel: "strict"` (no script, no click handlers, labels
 * sanitized). Until it's drawn, or if it can't be, the source stays visible.
 *
 * It is drawn in the OS's own colours (@asafarim/theme's tokens, read from the page when it draws, so
 * light and dark both match the rest of the reader) and redrawn when the theme changes. On a narrow
 * screen a wide diagram is never shrunk past readable: it keeps at least `MIN_SCALE` of its natural
 * size and scrolls sideways inside its own frame (never the page), and **Enlarge** opens it full
 * screen at its natural size.
 */
import { useEffect, useId, useRef, useState } from "react";

/** Dark when picked with the theme toggle (data-theme on <html>), else when the system is. */
const dark = () => {
  const picked = document.documentElement.dataset.theme;
  return picked ? picked === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};

/** What a screen reader hears: the diagram's own `title`, if it has one. */
export const mermaidLabel = (source: string) => {
  const title = /^\s*title:?\s+(.+?)\s*$/m.exec(source)?.[1];
  return title ? `Diagram: ${title}` : "Diagram";
};

/** A diagram is shrunk to fit at most down to this part of its natural size; past that it scrolls. */
export const MIN_SCALE = 0.7;

/**
 * The width to draw a diagram at: its natural width when that fits, else the frame's width as long as
 * that keeps `MIN_SCALE`, else `MIN_SCALE` of its natural width (and the frame scrolls).
 */
export function fitWidth(natural: number, frame: number): number {
  if (!(natural > 0) || !(frame > 0)) return natural;
  if (natural <= frame) return natural;
  return Math.round(Math.max(frame, natural * MIN_SCALE));
}

/** Mermaid's `base` theme, in the colours of @asafarim/theme (tokens on <html>, with fallbacks). */
export function themeVariables(token: (name: string) => string, isDark: boolean) {
  const t = (name: string, fallback: string) => token(name).trim() || fallback;
  const card = t("--card", isDark ? "#1c1c1c" : "#ffffff");
  const card2 = t("--card-2", isDark ? "#303030" : "#eef4f9");
  const ink = t("--ink", isDark ? "#f2f2f2" : "#15212b");
  const muted = t("--muted", isDark ? "#b5b5b5" : "#4b5b69");
  const accent = t("--accent", isDark ? "#7fb0dc" : "#0f4c6e");
  const line = t("--line", isDark ? "#3d3d3d" : "#b9cfdf");
  const warnBg = t("--warn-bg", isDark ? "#3a2e0c" : "#fef3c7");
  return {
    darkMode: isDark,
    background: card,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: "15px",
    primaryColor: card2,
    primaryTextColor: ink,
    primaryBorderColor: accent,
    secondaryColor: card,
    secondaryTextColor: ink,
    secondaryBorderColor: line,
    tertiaryColor: card,
    tertiaryTextColor: ink,
    tertiaryBorderColor: line,
    lineColor: muted,
    textColor: ink,
    mainBkg: card2,
    nodeBorder: accent,
    clusterBkg: card,
    clusterBorder: line,
    titleColor: ink,
    edgeLabelBackground: card,
    noteBkgColor: warnBg,
    noteTextColor: ink,
    noteBorderColor: line,
    actorBkg: card2,
    actorBorder: accent,
    actorTextColor: ink,
    actorLineColor: muted,
    signalColor: ink,
    signalTextColor: ink,
    labelBoxBkgColor: card2,
    labelBoxBorderColor: accent,
    labelTextColor: ink,
    loopTextColor: ink,
    activationBkgColor: card2,
    activationBorderColor: accent,
    sequenceNumberColor: card,
    // state and ER diagrams
    stateBkg: card2,
    stateLabelColor: ink,
    compositeBackground: card,
    altBackground: card,
    attributeBackgroundColorOdd: card,
    attributeBackgroundColorEven: card2,
    // pie and timeline
    pie1: accent,
    pieTitleTextColor: ink,
    pieSectionTextColor: isDark ? "#0d1b26" : "#ffffff",
    pieLegendTextColor: ink,
    pieStrokeColor: card,
    cScale0: card2,
    cScaleLabel0: ink,
  };
}

export function Mermaid({ source, children }: { source: string; children: React.ReactNode }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const ref = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<"source" | "drawn" | "failed">("source");
  const [svg, setSvg] = useState("");
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A colour-scheme or theme change can start a draw while one is running: each gets its own id, and only
    // the latest one is shown.
    let latest = 0;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    async function draw() {
      const run = ++latest;
      const current = () => !cancelled && run === latest;
      try {
        const mermaid = (await import("mermaid")).default;
        const style = getComputedStyle(document.documentElement);
        const isDark = dark();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: themeVariables((n) => style.getPropertyValue(n), isDark),
          flowchart: { useMaxWidth: false, htmlLabels: false, curve: "basis" },
          sequence: { useMaxWidth: false, mirrorActors: false },
          state: { useMaxWidth: false },
          er: { useMaxWidth: false },
          gantt: { useMaxWidth: false },
          journey: { useMaxWidth: false },
          timeline: { useMaxWidth: false },
          mindmap: { useMaxWidth: false },
          pie: { useMaxWidth: false },
          class: { useMaxWidth: false },
        });
        const drawn = await mermaid.render(`${id}-${run}`, source);
        if (!current() || !ref.current) return;
        ref.current.innerHTML = drawn.svg;
        setSvg(drawn.svg);
        setState("drawn");
        fit();
      } catch {
        if (current()) setState("failed");
      }
    }
    /** Size the drawn diagram for its frame (see `fitWidth`). */
    function fit() {
      const frame = ref.current;
      const el = frame?.querySelector("svg");
      if (!frame || !el) return;
      const box = el.viewBox?.baseVal;
      const natural = box && box.width ? box.width : el.getBoundingClientRect().width;
      const pad = getComputedStyle(frame);
      const room = frame.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      const width = fitWidth(natural, room);
      el.removeAttribute("height");
      el.style.maxWidth = "none";
      el.style.width = `${width}px`;
      el.style.height = "auto";
      setScrolls(width > room + 1);
    }
    void draw();
    media.addEventListener("change", draw);
    // The theme toggle changes data-theme on <html>: redraw in the new colours.
    const picked = new MutationObserver(() => void draw());
    picked.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const resized = new ResizeObserver(() => fit());
    if (ref.current) resized.observe(ref.current);
    return () => {
      cancelled = true;
      media.removeEventListener("change", draw);
      picked.disconnect();
      resized.disconnect();
    };
  }, [id, source]);

  const label = mermaidLabel(source);
  return (
    <figure className="mermaid" data-state={state} data-testid="mermaid">
      <div
        ref={ref}
        className="mermaid-svg"
        role="img"
        aria-label={label}
        hidden={state !== "drawn"}
        // A frame that scrolls must be reachable by keyboard.
        tabIndex={scrolls ? 0 : undefined}
      />
      {state !== "drawn" ? children : null}
      {state === "drawn" ? (
        <figcaption className="mermaid-tools">
          {scrolls ? <span className="muted">Scroll sideways to see all of it.</span> : <span />}
          <button type="button" className="mermaid-enlarge" onClick={() => big.current?.showModal()}>
            Enlarge
          </button>
        </figcaption>
      ) : null}
      {state === "failed" ? <figcaption className="muted">This diagram can&apos;t be drawn.</figcaption> : null}
      <dialog
        ref={big}
        className="mermaid-dialog"
        aria-label={label}
        onClick={(e) => e.target === big.current && big.current?.close()}
      >
        <form method="dialog" className="mermaid-dialog-bar">
          <span>{label.replace(/^Diagram: /, "")}</span>
          <button type="submit">Close</button>
        </form>
        {/* The same sanitized SVG mermaid drew above (securityLevel strict), at its natural size. */}
        <div className="mermaid-dialog-body" dangerouslySetInnerHTML={{ __html: svg }} />
      </dialog>
    </figure>
  );
}
