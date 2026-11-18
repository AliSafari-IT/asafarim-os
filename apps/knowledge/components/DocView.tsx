import "server-only";
/**
 * A structured article body (#356), rendered on the server from a PARSED document (lib/doc.ts) into React
 * elements: React escapes every text, links are already restricted to safe targets, and the only HTML string is
 * Shiki's highlighted code (Shiki escapes the code it is given). No author-supplied markup reaches the page.
 */
import type { ReactNode } from "react";
import { bundledLanguages, getSingletonHighlighter } from "shiki";
import { MermaidDiagram } from "@/components/MermaidDiagram";
import { headingIds, type Doc, type DocMark, type DocNode } from "@/lib/doc";

const THEMES = { light: "github-light-default", dark: "github-dark-default" } as const;
const PRELOADED = ["bash", "json", "yaml", "ts", "tsx", "js", "jsx", "sql", "diff", "css", "html", "python", "csharp"];

const highlighter = () => getSingletonHighlighter({ themes: Object.values(THEMES), langs: PRELOADED });

/** Shiki's id for a label, or null for plain text. */
function shikiLanguage(label: string | null): string | null {
  if (!label) return null;
  const alias: Record<string, string> = { "c#": "csharp", cs: "csharp", sh: "bash", shell: "bash", "c++": "cpp" };
  const id = alias[label] ?? label;
  return id in bundledLanguages ? id : null;
}

async function highlight(code: string, label: string | null): Promise<string> {
  const h = await highlighter();
  const lang = shikiLanguage(label);
  if (lang && !h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang as keyof typeof bundledLanguages);
  return h.codeToHtml(code, { lang: lang ?? "text", themes: THEMES, defaultColor: false });
}

function withMarks(text: string, marks: DocMark[] | undefined, key: string): ReactNode {
  let out: ReactNode = text;
  for (const m of marks ?? []) {
    if (m.type === "bold") out = <strong>{out}</strong>;
    else if (m.type === "italic") out = <em>{out}</em>;
    else if (m.type === "strike") out = <s>{out}</s>;
    else if (m.type === "underline") out = <u>{out}</u>;
    else if (m.type === "code") out = <code>{out}</code>;
    else if (m.type === "link" && m.attrs) {
      const external = /^(https?:|mailto:)/.test(m.attrs.href);
      out = (
        <a href={m.attrs.href} {...(external ? { rel: "noopener noreferrer nofollow" } : {})}>
          {out}
        </a>
      );
    }
  }
  return <span key={key}>{out}</span>;
}

const CALLOUT_LABEL: Record<string, string> = { note: "Note", tip: "Tip", warning: "Warning" };

export async function DocView({ doc }: { doc: Doc }) {
  const ids = headingIds(doc);
  const codes = new Map<DocNode, string>();
  const findCode = async (n: DocNode) => {
    if (n.type === "codeBlock") {
      const code = (n.content ?? []).map((c) => c.text ?? "").join("");
      codes.set(n, await highlight(code, (n.attrs?.language as string | null) ?? null));
    }
    for (const c of n.content ?? []) await findCode(c);
  };
  await findCode(doc);

  const render = (n: DocNode, key: string): ReactNode => {
    const kids = () => (n.content ?? []).map((c, i) => render(c, `${key}.${i}`));
    switch (n.type) {
      case "text":
        return withMarks(n.text ?? "", n.marks, key);
      case "hardBreak":
        return <br key={key} />;
      case "paragraph":
        return <p key={key}>{kids()}</p>;
      case "heading": {
        const level = Math.min(Math.max(Number(n.attrs?.level ?? 2), 1), 4) + 1; // the page's title is the h1
        const Tag = `h${Math.min(level, 6)}` as "h2";
        const id = ids.get(n)!;
        return (
          <Tag key={key} id={id}>
            {kids()}{" "}
            <a className="anchor" href={`#${id}`} aria-label="Link to this section">
              #
            </a>
          </Tag>
        );
      }
      case "blockquote":
        return <blockquote key={key}>{kids()}</blockquote>;
      case "callout": {
        const kind = String(n.attrs?.kind ?? "note");
        return (
          <aside key={key} className={`callout ${kind}`} role="note" aria-label={CALLOUT_LABEL[kind]}>
            <strong className="callout-label">{CALLOUT_LABEL[kind]}</strong>
            {kids()}
          </aside>
        );
      }
      case "bulletList":
        return <ul key={key}>{kids()}</ul>;
      case "orderedList":
        return (
          <ol key={key} start={Number(n.attrs?.start ?? 1)}>
            {kids()}
          </ol>
        );
      case "listItem":
        return <li key={key}>{kids()}</li>;
      case "codeBlock": {
        const label = (n.attrs?.language as string | null) ?? null;
        return (
          <figure key={key} className="code" data-language={label ?? "text"}>
            {label ? <figcaption>{label}</figcaption> : null}
            <div dangerouslySetInnerHTML={{ __html: codes.get(n) ?? "" }} />
          </figure>
        );
      }
      case "horizontalRule":
        return <hr key={key} />;
      case "mermaid":
        return (
          <MermaidDiagram
            key={key}
            source={String(n.attrs?.source ?? "")}
            description={String(n.attrs?.description ?? "")}
          />
        );
      case "table":
        return (
          <div key={key} className="table-wrap" tabIndex={0} role="region" aria-label="Table">
            <table>
              <tbody>{kids()}</tbody>
            </table>
          </div>
        );
      case "tableRow":
        return <tr key={key}>{kids()}</tr>;
      case "tableHeader":
      case "tableCell": {
        const Cell = n.type === "tableHeader" ? "th" : "td";
        const colSpan = Number(n.attrs?.colspan ?? 1);
        const rowSpan = Number(n.attrs?.rowspan ?? 1);
        return (
          <Cell key={key} {...(colSpan > 1 ? { colSpan } : {})} {...(rowSpan > 1 ? { rowSpan } : {})}>
            {kids()}
          </Cell>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="prose" data-testid="article-body">
      {doc.content.map((n, i) => render(n, String(i)))}
    </div>
  );
}
