"use client";
/**
 * The structured draft editor (#356): Tiptap with the extension set lib/doc.ts accepts (headings, lists, quotes,
 * callouts, code blocks with a language, tables, links). It saves a new revision on top of the one it opened; the
 * server validates the document before storing it. A Phase 0 Markdown revision is converted when it is opened, and
 * the page lists anything the conversion drops (lib/markdown-check.ts). A refused save (a conflict, a validation
 * error, an expired session) leaves the editor exactly as it was: the editor and fields live in this component.
 */
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { autosaveAction, saveDraftAction, type AutosaveResult, type SaveState } from "@/app/studio/actions";
import { AiPanel } from "@/components/AiPanel";
import { Callout } from "@/lib/callout";
import { Mermaid } from "@/lib/mermaid-node";
import { AttachmentNode, ImageNode, uploadFile, VideoNode } from "@/lib/media-nodes";
import { MEDIA_TYPES, parseVideoUrl } from "@/lib/media/validate";
import { textExtensions } from "@/lib/editor-extensions";
import { RichPaste } from "@/lib/rich-paste";
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
  /** The media store is configured (#359): uploads are offered. Videos need no store. */
  mediaEnabled?: boolean;
  /** Milliseconds of quiet before an autosave (#372); tests shorten it. */
  autosaveDelay?: number;
}

/** How long after the last keystroke the editor keeps the text as an autosave. */
export const AUTOSAVE_DELAY_MS = 3_000;

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

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

type MediaMessage = { bad: boolean; text: string } | null;

/**
 * Upload image or PDF files one after another (straight to the store, checked by the server) and insert each where
 * the cursor is. Used by the toolbar's file picker and by pasting or dropping an image into the body.
 */
async function uploadAndInsert(editor: Editor, files: File[], say: (m: MediaMessage) => void): Promise<void> {
  for (const file of files) {
    say({ bad: false, text: `Uploading ${file.name || "image"}…` });
    try {
      const r = await uploadFile(file);
      if (!r.ok) return say({ bad: true, text: ERRORS[r.error] ?? r.error });
      if (r.asset.kind === "image") editor.chain().focus().insertImage({ asset: r.asset.id }).run();
      else editor.chain().focus().insertAttachment({ asset: r.asset.id, label: r.asset.filename }).run();
    } catch {
      return say({ bad: true, text: ERRORS.media_not_uploaded! });
    }
  }
  const images = files.filter((f) => f.type.startsWith("image/")).length;
  say({
    bad: false,
    text: images
      ? `${images === 1 ? "Image" : `${images} images`} added. Write the alt text below each image.`
      : "File added.",
  });
}

/**
 * Media tools (#359): upload an image or PDF (straight to the store, checked by the server, then inserted), and
 * embed a video by its YouTube or Vimeo address. Status and errors are announced in place, never in a dialog.
 */
function MediaTools({
  editor,
  uploads,
  busy,
  message,
  onFiles,
  setMessage,
}: {
  editor: Editor;
  uploads: boolean;
  busy: boolean;
  message: MediaMessage;
  onFiles: (files: File[]) => Promise<void>;
  setMessage: (m: MediaMessage) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [address, setAddress] = useState("");

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await onFiles([file]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const addVideo = () => {
    const v = parseVideoUrl(address);
    if (!v) return setMessage({ bad: true, text: ERRORS.video_invalid! });
    editor.chain().focus().insertVideo({ provider: v.provider, videoId: v.id }).run();
    setAddress("");
    setVideoOpen(false);
    setMessage({ bad: false, text: "Video added. Give it a title." });
  };

  return (
    <>
      {uploads ? (
        <>
          <input
            ref={fileInput}
            type="file"
            style={{ display: "none" }}
            accept={Object.keys(MEDIA_TYPES).join(",")}
            onChange={(e) => onFile(e.target.files?.[0])}
            data-testid="media-file"
          />
          <button
            type="button"
            className="tool"
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInput.current?.click()}
            title="Upload an image (PNG, JPEG, GIF, WebP) or a PDF"
          >
            {busy ? "Uploading…" : "Image / file"}
          </button>
        </>
      ) : null}
      <button
        type="button"
        className={videoOpen ? "tool active" : "tool"}
        aria-expanded={videoOpen}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setVideoOpen((o) => !o)}
        title="Embed a YouTube or Vimeo video"
      >
        Video
      </button>
      {videoOpen ? (
        <span className="inline">
          <label>
            <span className="visually-hidden">YouTube or Vimeo address</span>
            <input
              value={address}
              placeholder="https://www.youtube.com/watch?v=…"
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addVideo();
                }
              }}
              data-testid="video-address"
            />
          </label>
          <button type="button" className="tool" onClick={addVideo} data-testid="video-add">
            Add
          </button>
        </span>
      ) : null}
      {message ? (
        <span
          className={message.bad ? "notice bad" : "muted"}
          role={message.bad ? "alert" : "status"}
          data-testid="media-message"
        >
          {message.text}
        </span>
      ) : null}
    </>
  );
}

interface MediaState {
  busy: boolean;
  message: MediaMessage;
  onFiles: (files: File[]) => Promise<void>;
  setMessage: (m: MediaMessage) => void;
}

const ALIGNS = [
  ["", "Align left"],
  ["center", "Centre"],
  ["right", "Align right"],
  ["justify", "Justify"],
] as const;

function Toolbar({ editor, mediaEnabled, media }: { editor: Editor; mediaEnabled: boolean; media: MediaState }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      align: (["center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "",
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
      {b("Mark", s.highlight, () => chain().toggleHighlight().run(), "Highlight")}
      {b("Link", s.link, setLink)}
      <span className="sep" />
      {b("H2", s.h2, () => chain().toggleHeading({ level: 2 }).run(), "Heading")}
      {b("H3", s.h3, () => chain().toggleHeading({ level: 3 }).run(), "Subheading")}
      {b("• List", s.bullet, () => chain().toggleBulletList().run(), "Bulleted list")}
      {b("1. List", s.ordered, () => chain().toggleOrderedList().run(), "Numbered list")}
      {b("Quote", s.quote, () => chain().toggleBlockquote().run())}
      <label className="inline">
        <span className="visually-hidden">Alignment</span>
        <select
          value={s.align}
          onChange={(e) =>
            e.target.value ? chain().setTextAlign(e.target.value).run() : chain().unsetTextAlign().run()
          }
          data-testid="text-align"
        >
          {ALIGNS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
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
      <MediaTools editor={editor} uploads={mediaEnabled} {...media} />
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
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaMessage, setMediaMessage] = useState<MediaMessage>(null);
  const editorRef = useRef<Editor | null>(null);
  const uploads = props.canEdit && (props.mediaEnabled ?? false);

  const onFiles = async (files: File[]) => {
    const e = editorRef.current;
    if (!e || !files.length) return;
    setMediaBusy(true);
    try {
      await uploadAndInsert(e, files, setMediaMessage);
    } finally {
      setMediaBusy(false);
    }
  };
  // The paste handler is set up once with the editor; it calls the newest upload function through this ref.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  const editor = useEditor({
    // Rendered on the client only: the page's HTML has no editor markup to hydrate against.
    immediatelyRender: false,
    editable: props.canEdit,
    extensions: [
      ...textExtensions(),
      RichPaste.configure({
        onImageFiles: uploads ? (files) => void onFilesRef.current(files) : null,
        onDroppedImages: (n) =>
          setMediaMessage({
            bad: false,
            text: `Formatting kept. ${n === 1 ? "1 image" : `${n} images`} from the other page can't be copied${
              uploads ? ": save each one and add it with Image / file (or paste the image itself)." : "."
            }`,
          }),
      }),
      Callout,
      Mermaid,
      ImageNode,
      AttachmentNode,
      VideoNode,
      Markdown,
    ],
    ...(props.doc ? { content: props.doc } : { content: props.markdown, contentType: "markdown" as const }),
    editorProps: { attributes: { class: "prose editor-area", "aria-label": "Article body", "data-testid": "body" } },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
      setDoc(JSON.stringify(e.getJSON()));
    },
    onUpdate: ({ editor: e }) => setDoc(JSON.stringify(e.getJSON())),
  });

  // The draft head the page was rendered with. After a conflict the action refreshes the page, so this becomes
  // the newer revision and the next save builds on it, deliberately: the message says so. The form is keyed by the
  // article, not the revision, so that refresh never resets the author's text.
  const expected = props.revisionId;

  // Autosave (#372): a few seconds after the last change, keep the text on the server as this author's autosave.
  // It never becomes a revision; when someone saved a newer one meanwhile, the editor says so and links the
  // comparison instead of saving on top of it.
  const [autosave, setAutosave] = useState<AutosaveResult | null>(null);
  const initial = useRef<string | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!props.canEdit || !doc) return;
    const payload = JSON.stringify([title, summary, doc]);
    if (initial.current === null) {
      initial.current = payload; // what the page opened with: nothing to keep yet
      last.current = payload;
      return;
    }
    if (payload === last.current) return;
    const timer = setTimeout(async () => {
      last.current = payload;
      try {
        setAutosave(await autosaveAction({ id: props.id, baseRevisionId: expected, title, summary, doc }));
      } catch {
        setAutosave({ ok: false, error: "autosave_failed" });
      }
    }, props.autosaveDelay ?? AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [title, summary, doc, expected, props.id, props.canEdit, props.autosaveDelay]);

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
      {editor && props.canEdit ? (
        <Toolbar
          editor={editor}
          mediaEnabled={props.mediaEnabled ?? false}
          media={{ busy: mediaBusy, message: mediaMessage, onFiles, setMessage: setMediaMessage }}
        />
      ) : null}
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
      <div className="save-row">
        <button type="submit" disabled={pending || !props.canEdit || !doc} data-testid="save">
          {pending ? "Saving…" : "Save draft"}
        </button>
        {autosave?.ok && !autosave.conflict ? (
          <span className="muted" role="status" data-testid="autosave-status">
            Unsaved changes kept at {clock(autosave.savedAt)}
          </span>
        ) : null}
        {autosave && !autosave.ok ? (
          <span className="muted" role="status" data-testid="autosave-status">
            Autosave didn&apos;t work ({ERRORS[autosave.error] ?? autosave.error}). Your text is still here.
          </span>
        ) : null}
      </div>
      {autosave?.ok && autosave.conflict ? (
        <div className="notice bad" role="alert" data-testid="autosave-conflict">
          Someone saved a newer revision while you were editing. Your text is kept (at {clock(autosave.savedAt)}) and
          nothing was overwritten.{" "}
          <Link href={`/studio/content/${props.id}/compare?from=head&to=autosave`} data-testid="autosave-compare">
            Compare your text with the newest revision
          </Link>{" "}
          before you save.
        </div>
      ) : null}
    </form>
  );
}
