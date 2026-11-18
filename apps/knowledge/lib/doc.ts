/**
 * The article document (#356): Tiptap/ProseMirror JSON, the canonical format of new revisions. Everything that
 * comes from a browser goes through `parseDoc` before it is stored or rendered: only the node and mark types the
 * editor offers, only their known attributes (normalised; anything else dropped), links only to http(s), mailto,
 * site-relative paths and in-page anchors, and bounded size and depth. Rendering (components/DocView.tsx) only ever
 * sees a parsed document, so no author-supplied HTML, script, style or event handler can reach a page.
 */

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  nodes: 20_000,
  depth: 24,
  text: 200_000,
  language: 32,
  mermaid: 5_000,
  mermaidLines: 200,
  mermaidDescription: 500,
} as const;

/** The diagram types a Mermaid block may start with (its first non-comment word). */
export const MERMAID_TYPES = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "mindmap",
  "timeline",
  "gitGraph",
  "quadrantChart",
] as const;

export type MermaidCheck = { ok: true; source: string } | { ok: false; error: string };

/**
 * A Mermaid source the page may draw (#360): one of the known diagram types, bounded in size, and without the
 * parts that would let a diagram change how it is drawn or act: no `%%{init}` directives (configuration, which
 * could lower the security level or load fonts), no `click` / `callback` / `href` interactions, no HTML or script.
 * The page also draws with `securityLevel: "strict"`; this check is the first of the two.
 */
export function checkMermaid(raw: unknown): MermaidCheck {
  if (typeof raw !== "string") return { ok: false, error: "mermaid_invalid" };
  const source = raw.replace(/\r\n?/g, "\n").trim();
  if (!source || source.length > LIMITS.mermaid || source.split("\n").length > LIMITS.mermaidLines) {
    return { ok: false, error: "mermaid_too_large" };
  }
  if (/%%\s*\{/.test(source) || /^\s*---\s*$/m.test(source)) return { ok: false, error: "mermaid_config" };
  if (/^\s*(click|callback|href)\b/m.test(source) || /\b(click|callback)\s+\w+\s+(call|href)\b/.test(source)) {
    return { ok: false, error: "mermaid_interaction" };
  }
  if (/<\s*\/?\s*[a-z!]/i.test(source) || /javascript:/i.test(source)) return { ok: false, error: "mermaid_html" };
  const first = source
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("%%"));
  const type = first?.split(/\s+/)[0] ?? "";
  if (!(MERMAID_TYPES as readonly string[]).includes(type)) return { ok: false, error: "mermaid_type" };
  return { ok: true, source };
}

export const CALLOUT_KINDS = ["note", "tip", "warning"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export interface DocMark {
  type: "bold" | "italic" | "strike" | "underline" | "code" | "link";
  attrs?: { href: string };
}

export interface DocNode {
  type: string;
  attrs?: Record<string, string | number | null>;
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
}

export interface Doc extends DocNode {
  type: "doc";
  content: DocNode[];
}

export type DocResult = { ok: true; doc: Doc; text: string } | { ok: false; error: string };

/** What each node may contain: "block" children, "inline" children, a fixed child type, or nothing. */
const NODES: Record<string, { children: "block" | "inline" | "none" | string[]; inList?: boolean }> = {
  doc: { children: "block" },
  paragraph: { children: "inline" },
  heading: { children: "inline" },
  blockquote: { children: "block" },
  callout: { children: "block" },
  bulletList: { children: ["listItem"] },
  orderedList: { children: ["listItem"] },
  listItem: { children: "block" },
  codeBlock: { children: "inline" },
  horizontalRule: { children: "none" },
  mermaid: { children: "none" },
  table: { children: ["tableRow"] },
  tableRow: { children: ["tableHeader", "tableCell"] },
  tableHeader: { children: "block" },
  tableCell: { children: "block" },
  text: { children: "none" },
  hardBreak: { children: "none" },
};
const BLOCK = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "callout",
  "bulletList",
  "orderedList",
  "codeBlock",
  "horizontalRule",
  "table",
  "mermaid",
]);
const INLINE = new Set(["text", "hardBreak"]);
const MARKS = new Set(["bold", "italic", "strike", "underline", "code", "link"]);

/** A link the page may carry: http(s), mailto, a path on this site, or an anchor in the page. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const href = raw.trim();
  if (!href || href.length > 2048) return null;
  if (href.startsWith("#")) return /^#[\w.-]{1,128}$/.test(href) ? href : null;
  if (href.startsWith("/")) return href.startsWith("//") || href.includes("\\") ? null : href;
  try {
    const u = new URL(href);
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A code block's language label: lower-case letters, digits and +#.- (e.g. ts, c#, c++, objective-c). */
export function safeLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lang = raw.trim().toLowerCase();
  return lang && lang.length <= LIMITS.language && /^[a-z0-9][a-z0-9+#.-]*$/.test(lang) ? lang : null;
}

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

class Invalid extends Error {}

/** Validate and normalise an untrusted document (an object, or its JSON text). */
export function parseDoc(input: unknown): DocResult {
  let value = input;
  if (typeof input === "string") {
    if (input.length > LIMITS.text * 4) return { ok: false, error: "doc_too_large" };
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, error: "doc_invalid" };
    }
  }
  let nodes = 0;
  let textLength = 0;
  const lines: string[] = [];

  function marksOf(raw: unknown): DocMark[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw new Invalid("doc_invalid");
    const out: DocMark[] = [];
    for (const m of raw) {
      const type = (m as { type?: unknown })?.type;
      if (typeof type !== "string" || !MARKS.has(type)) throw new Invalid("doc_invalid");
      if (out.some((x) => x.type === type)) continue;
      if (type === "link") {
        const href = safeHref((m as { attrs?: { href?: unknown } }).attrs?.href);
        if (href) out.push({ type: "link", attrs: { href } }); // an unsafe link drops the mark, keeps the text
      } else out.push({ type: type as DocMark["type"] });
    }
    return out.length ? out : undefined;
  }

  function attrsOf(type: string, raw: Record<string, unknown>): DocNode["attrs"] {
    switch (type) {
      case "heading":
        return { level: int(raw.level, 1, 4) ?? 2 };
      case "orderedList":
        return { start: int(raw.start, 1, 100_000) ?? 1 };
      case "codeBlock":
        return { language: safeLanguage(raw.language) };
      case "callout":
        return { kind: CALLOUT_KINDS.includes(raw.kind as CalloutKind) ? (raw.kind as string) : "note" };
      case "mermaid": {
        const m = checkMermaid(raw.source);
        if (!m.ok) throw new Invalid(m.error);
        const description = typeof raw.description === "string" ? raw.description.trim() : "";
        if (description.length > LIMITS.mermaidDescription) throw new Invalid("mermaid_description_too_long");
        return { source: m.source, description };
      }
      case "tableCell":
      case "tableHeader":
        return { colspan: int(raw.colspan, 1, 20) ?? 1, rowspan: int(raw.rowspan, 1, 100) ?? 1 };
      default:
        return undefined;
    }
  }

  function walk(raw: unknown, depth: number, allowed: (type: string) => boolean): DocNode {
    if (++nodes > LIMITS.nodes) throw new Invalid("doc_too_large");
    if (depth > LIMITS.depth) throw new Invalid("doc_too_deep");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Invalid("doc_invalid");
    const r = raw as Record<string, unknown>;
    const type = r.type;
    if (typeof type !== "string" || !(type in NODES) || type === "doc" || !allowed(type)) {
      throw new Invalid("doc_invalid");
    }
    if (type === "text") {
      if (typeof r.text !== "string" || r.text.length === 0) throw new Invalid("doc_invalid");
      textLength += r.text.length;
      if (textLength > LIMITS.text) throw new Invalid("doc_too_large");
      const marks = marksOf(r.marks);
      return marks ? { type, text: r.text, marks } : { type, text: r.text };
    }
    const node: DocNode = { type };
    const attrs = attrsOf(type, (r.attrs && typeof r.attrs === "object" ? r.attrs : {}) as Record<string, unknown>);
    if (attrs) node.attrs = attrs;
    const spec = NODES[type]!;
    const kids = r.content === undefined ? [] : r.content;
    if (!Array.isArray(kids)) throw new Invalid("doc_invalid");
    if (spec.children === "none") {
      if (kids.length) throw new Invalid("doc_invalid");
      return node;
    }
    const childAllowed =
      spec.children === "block"
        ? (t: string) => BLOCK.has(t)
        : spec.children === "inline"
          ? (t: string) => (type === "codeBlock" ? t === "text" : INLINE.has(t))
          : (t: string) => (spec.children as string[]).includes(t);
    // Code is code: no marks inside a code block.
    const content = kids.map((k) => walk(k, depth + 1, childAllowed));
    if (type === "codeBlock") for (const c of content) delete c.marks;
    if (content.length) node.content = content;
    return node;
  }

  /** The text of a node, for search and summaries: blocks on their own lines. */
  function collect(n: DocNode, acc: string[]): void {
    if (n.type === "text") acc.push(n.text ?? "");
    else if (n.type === "hardBreak") acc.push("\n");
    for (const c of n.content ?? []) collect(c, acc);
  }

  try {
    if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "doc") {
      return { ok: false, error: "doc_invalid" };
    }
    const kids = (value as { content?: unknown }).content ?? [];
    if (!Array.isArray(kids)) return { ok: false, error: "doc_invalid" };
    const content = kids.map((k) => walk(k, 1, (t) => BLOCK.has(t)));
    const doc: Doc = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
    const blocks = (n: DocNode): void => {
      if (n.type === "mermaid") {
        if (n.attrs?.description) lines.push(String(n.attrs.description));
      } else if (["paragraph", "heading", "codeBlock"].includes(n.type)) {
        const acc: string[] = [];
        collect(n, acc);
        lines.push(acc.join(""));
      } else for (const c of n.content ?? []) blocks(c);
    };
    blocks(doc);
    return { ok: true, doc, text: lines.filter((l) => l.length).join("\n") };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

export const EMPTY_DOC: Doc = { type: "doc", content: [{ type: "paragraph" }] };

/** A heading's anchor: lower-case words joined by dashes, unique in the document (a counter on repeats). */
export function headingIds(doc: Doc): Map<DocNode, string> {
  const ids = new Map<DocNode, string>();
  const used = new Map<string, number>();
  const visit = (n: DocNode) => {
    if (n.type === "heading") {
      const text = (n.content ?? []).map((c) => c.text ?? "").join("");
      const base =
        text
          .normalize("NFKD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64) || "section";
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      ids.set(n, seen ? `${base}-${seen + 1}` : base);
    }
    for (const c of n.content ?? []) visit(c);
  };
  visit(doc);
  return ids;
}
