"use client";
/**
 * The structured draft editor (#356): Tiptap with the extension set lib/doc.ts accepts (headings, lists, quotes,
 * callouts, code blocks with a language, tables, links). It saves a new revision on top of the one it opened; the
 * server validates the document before storing it. A Phase 0 Markdown revision is converted when it is opened, and
 * the page lists anything the conversion drops (lib/markdown-check.ts). A refused save (a conflict, a validation
 * error, an expired session) leaves the editor exactly as it was: the editor and fields live in this component.
 */
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useActionState, useState } from "react";
import { saveDraftAction, type SaveState } from "@/app/studio/actions";
import { AiPanel } from "@/components/AiPanel";
import { Callout } from "@/lib/callout";
import { Mermaid } from "@/lib/mermaid-node";
import { safeHref, type Doc } from "@/lib/doc";
import { ERRORS } from "@/lib/messages";

export interface EditorFormProps {
  id: string;
  revisionId: string;
  title: string;
  summary: string;
  /** The draft head: a document, or (Phase 0) Markdown to convert. */
  doc: Doc | null;
  markdown: string;
  canEdit: boolean;
  /** AI assistance is configured and the person holds knowledge.ai.use. */
  aiEnabled: boolean;
}

export const LANGUAGES = [
  "",
  "bash",
  "csharp",
  "css",
  "diff",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "python",
  "rust",
  "sql",
  "ts",
  "tsx",
  "yaml",
];

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      callout: e.isActive("callout"),
      codeBlock: e.isActive("codeBlock"),
      language: (e.getAttributes("codeBlock").language as string | null) ?? "",
      table: e.isActive("table"),
    }),
  });
  const b = (label: string, active: boolean, run: () => void, title = label) => (
    <button
      type="button"
      className={active ? "tool active" : "tool"}
      aria-pressed={active}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  const chain = () => editor.chain().focus();
  const setLink = () => {
    const current = (editor.getAttributes("link").href as string | undefined) ?? "";
    const raw = window.prompt("Link address (https://…, /path or #section). Empty removes the link.", current);
    if (raw === null) return;
    if (!raw.trim()) return void chain().extendMarkRange("link").unsetLink().run();
    const href = safeHref(raw);
    if (!href) return void window.alert("Only http(s), mailto, /paths on this site and #anchors are allowed.");
    chain().extendMarkRange("link").setLink({ href }).run();
  };
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting" data-testid="toolbar">
      {b("B", s.bold, () => chain().toggleBold().run(), "Bold")}
      {b("I", s.italic, () => chain().toggleItalic().run(), "Italic")}
      {b("`code`", s.code, () => chain().toggleCode().run(), "Inline code")}
      {b("Link", s.link, setLink)}
      <span className="sep" />
      {b("H2", s.h2, () => chain().toggleHeading({ level: 2 }).run(), "Heading")}
      {b("H3", s.h3, () => chain().toggleHeading({ level: 3 }).run(), "Subheading")}
      {b("• List", s.bullet, () => chain().toggleBulletList().run(), "Bulleted list")}
      {b("1. List", s.ordered, () => chain().toggleOrderedList().run(), "Numbered list")}
      {b("Quote", s.quote, () => chain().toggleBlockquote().run())}
      {b("Callout", s.callout, () => chain().toggleCallout("note").run())}
      {b(
        "Diagram",
        false,
        () => chain().insertMermaid({ source: 'flowchart TD\n  A["Start"] --> B["End"]' }).run(),
        "Mermaid diagram",
      )}
      <span className="sep" />
      {b("Code block", s.codeBlock, () => chain().toggleCodeBlock().run())}
      {s.codeBlock ? (
        <label className="inline">
          <span className="visually-hidden">Code language</span>
          <select
            value={s.language}
            onChange={(e) =>
              chain()
                .updateAttributes("codeBlock", { language: e.target.value || null })
                .run()
            }
            data-testid="code-language"
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l || "plain text"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {b("Table", s.table, () =>
        s.table ? chain().deleteTable().run() : chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      )}
      {s.table ? (
        <>
          {b("+ Row", false, () => chain().addRowAfter().run(), "Add a row below")}
          {b("+ Column", false, () => chain().addColumnAfter().run(), "Add a column to the right")}
        </>
      ) : null}
      <span className="sep" />
      {b("Undo", false, () => chain().undo().run())}
      {b("Redo", false, () => chain().redo().run())}
    </div>
  );
}

export function EditorForm(props: EditorFormProps) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveDraftAction, {});
  const [title, setTitle] = useState(props.title);
  const [summary, setSummary] = useState(props.summary);
  const [doc, setDoc] = useState<string>("");

  const editor = useEditor({
    // Rendered on the client only: the page's HTML has no editor markup to hydrate against.
    immediatelyRender: false,
    editable: props.canEdit,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        link: { openOnClick: false, autolink: true, isAllowedUri: (url) => safeHref(url) !== null },
      }),
      TableKit.configure({ table: { resizable: false } }),
      Callout,
      Mermaid,
      Markdown,
    ],
    ...(props.doc ? { content: props.doc } : { content: props.markdown, contentType: "markdown" as const }),
    editorProps: { attributes: { class: "prose editor-area", "aria-label": "Article body", "data-testid": "body" } },
    onCreate: ({ editor: e }) => setDoc(JSON.stringify(e.getJSON())),
    onUpdate: ({ editor: e }) => setDoc(JSON.stringify(e.getJSON())),
  });

  // The draft head the page was rendered with. After a conflict the action refreshes the page, so this becomes
  // the newer revision and the next save builds on it, deliberately: the message says so. The form is keyed by the
  // article, not the revision, so that refresh never resets the author's text.
  const expected = props.revisionId;

  return (
    <form action={action} className="card editor" data-testid="editor">
      {state.error ? (
        <div className="notice bad" role="alert" data-testid="save-error">
          {ERRORS[state.error] ?? state.error}
        </div>
      ) : null}
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="expectedRevisionId" value={expected} />
      <input type="hidden" name="doc" value={doc} />
      <label>
        Title
        <input
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          disabled={!props.canEdit}
        />
      </label>
      <label>
        Summary
        <textarea
          name="summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          maxLength={500}
          disabled={!props.canEdit}
        />
      </label>
      <span className="field-label" id="body-label">
        Body
      </span>
      {editor && props.canEdit ? <Toolbar editor={editor} /> : null}
      <div className="editor-frame" aria-labelledby="body-label">
        <EditorContent editor={editor} />
      </div>
      {editor && props.canEdit && props.aiEnabled ? (
        <AiPanel
          editor={editor}
          itemId={props.id}
          baseRevisionId={props.revisionId}
          title={title}
          onSummary={setSummary}
          onTitle={setTitle}
        />
      ) : null}
      <button type="submit" disabled={pending || !props.canEdit || !doc} data-testid="save">
        {pending ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}
