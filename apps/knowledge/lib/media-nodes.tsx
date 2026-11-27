"use client";
/**
 * Media in the editor (#359): an uploaded image (alt text and caption edited in place), an attached file (its
 * label), and a video (provider and id, its title edited in place). Atom nodes, stored and rendered through
 * lib/doc.ts like every other node; the server refuses an image without alt text or a video without a title.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { finishUploadAction, requestUploadAction, type UploadDone } from "@/app/studio/media-actions";
import { MEDIA_LIMITS, VIDEO_LABEL, isVideoId, svgDataUrl, type VideoProvider } from "./media/validate";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    media: {
      /** Exactly one source: an uploaded asset, an https address, or SVG code. */
      insertImage: (attrs: ({ asset: string } | { src: string } | { svg: string }) & { alt?: string }) => ReturnType;
      insertAttachment: (attrs: { asset: string; label: string }) => ReturnType;
      insertVideo: (attrs: { provider: VideoProvider; videoId: string; title?: string }) => ReturnType;
    };
  }
}

/** The whole upload: ask for a ticket, send the file straight to the store, let the server check it. */
export async function uploadFile(file: File): Promise<UploadDone> {
  const ticket = await requestUploadAction({ filename: file.name, contentType: file.type, size: file.size });
  if (!ticket.ok) return ticket;
  try {
    const res = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: file });
    if (!res.ok) return { ok: false, error: "media_not_uploaded" };
  } catch {
    return { ok: false, error: "media_not_uploaded" };
  }
  return finishUploadAction(ticket.id);
}

function Head({ label, editor, deleteNode }: Pick<ReactNodeViewProps, "editor" | "deleteNode"> & { label: string }) {
  return (
    <div className="mermaid-head">
      <strong>{label}</strong>
      {editor.isEditable ? (
        <button type="button" className="tool" onClick={() => deleteNode()}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

/** Where an image node's picture comes from, as an <img> src (an SVG only ever as a data: URL). */
export function imageSrc(attrs: Record<string, unknown>): string {
  if (typeof attrs.asset === "string" && attrs.asset) return `/media/${attrs.asset}`;
  if (typeof attrs.src === "string" && attrs.src) return attrs.src;
  return svgDataUrl(typeof attrs.svg === "string" ? attrs.svg : "");
}

function ImageView({ node, updateAttributes, editor, deleteNode }: ReactNodeViewProps) {
  const alt = String(node.attrs.alt ?? "");
  const caption = String(node.attrs.caption ?? "");
  const kind = node.attrs.asset ? "uploaded" : node.attrs.src ? "from another site" : "SVG";
  return (
    <NodeViewWrapper className="media-block" data-testid="image-block">
      <Head label={`Image (${kind})`} editor={editor} deleteNode={deleteNode} />
      <div contentEditable={false}>
        {/* An upload is read through /media/:id like a guest reads it; an address from that site; SVG as data:. */}
        <img src={imageSrc(node.attrs)} alt={alt} referrerPolicy="no-referrer" />
      </div>
      {node.attrs.src ? (
        <p className="muted" style={{ overflowWrap: "anywhere" }}>
          Loaded from <code>{String(node.attrs.src)}</code>: readers&apos; browsers fetch it from that site.
        </p>
      ) : null}
      {node.attrs.svg ? (
        <label>
          SVG code
          <textarea
            value={String(node.attrs.svg)}
            rows={4}
            maxLength={MEDIA_LIMITS.svg}
            readOnly={!editor.isEditable}
            spellCheck={false}
            onChange={(e) => updateAttributes({ svg: e.target.value })}
            data-testid="image-svg"
          />
        </label>
      ) : null}
      <label>
        Alt text (required: what the image shows, for readers who can&apos;t see it)
        <input
          value={alt}
          maxLength={MEDIA_LIMITS.alt}
          readOnly={!editor.isEditable}
          aria-invalid={!alt.trim()}
          onChange={(e) => updateAttributes({ alt: e.target.value })}
          data-testid="image-alt"
        />
      </label>
      <label>
        Caption (optional)
        <input
          value={caption}
          maxLength={MEDIA_LIMITS.caption}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ caption: e.target.value })}
        />
      </label>
    </NodeViewWrapper>
  );
}

function AttachmentView({ node, updateAttributes, editor, deleteNode }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper className="media-block" data-testid="attachment-block">
      <Head label="File" editor={editor} deleteNode={deleteNode} />
      <label>
        Link text
        <input
          value={String(node.attrs.label ?? "")}
          maxLength={MEDIA_LIMITS.label}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ label: e.target.value })}
        />
      </label>
    </NodeViewWrapper>
  );
}

function VideoView({ node, updateAttributes, editor, deleteNode }: ReactNodeViewProps) {
  const provider = node.attrs.provider as VideoProvider;
  const title = String(node.attrs.title ?? "");
  const valid = isVideoId(provider, node.attrs.videoId);
  return (
    <NodeViewWrapper className="media-block" data-testid="video-block">
      <Head label={`Video (${valid ? VIDEO_LABEL[provider] : "invalid"})`} editor={editor} deleteNode={deleteNode} />
      <p className="muted">
        Readers see a placeholder; the player loads only when they press play. Video id:{" "}
        <code>{String(node.attrs.videoId)}</code>
      </p>
      <label>
        Title (required)
        <input
          value={title}
          maxLength={MEDIA_LIMITS.videoTitle}
          readOnly={!editor.isEditable}
          aria-invalid={!title.trim()}
          onChange={(e) => updateAttributes({ title: e.target.value })}
          data-testid="video-title"
        />
      </label>
    </NodeViewWrapper>
  );
}

const atom = { group: "block", atom: true, selectable: true, draggable: false } as const;

export const ImageNode = Node.create({
  name: "image",
  ...atom,
  addAttributes: () => ({
    asset: { default: null },
    src: { default: null },
    svg: { default: null },
    alt: { default: "" },
    caption: { default: "" },
  }),
  parseHTML: () => [{ tag: "figure[data-image]" }],
  renderHTML: ({ HTMLAttributes }) => ["figure", mergeAttributes(HTMLAttributes, { "data-image": "" })],
  addNodeView: () => ReactNodeViewRenderer(ImageView),
  addCommands() {
    return {
      insertImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { alt: "", caption: "", ...attrs } }),
    };
  },
});

export const AttachmentNode = Node.create({
  name: "attachment",
  ...atom,
  addAttributes: () => ({ asset: { default: null }, label: { default: "" } }),
  parseHTML: () => [{ tag: "p[data-attachment]" }],
  renderHTML: ({ HTMLAttributes }) => ["p", mergeAttributes(HTMLAttributes, { "data-attachment": "" })],
  addNodeView: () => ReactNodeViewRenderer(AttachmentView),
  addCommands() {
    return {
      insertAttachment:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

export const VideoNode = Node.create({
  name: "video",
  ...atom,
  addAttributes: () => ({ provider: { default: "youtube" }, videoId: { default: "" }, title: { default: "" } }),
  // Never parsed from pasted HTML: a video only comes in through the toolbar's address check.
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => ["figure", mergeAttributes(HTMLAttributes, { "data-video": "" })],
  addNodeView: () => ReactNodeViewRenderer(VideoView),
  addCommands() {
    return {
      insertVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { title: "", ...attrs } }),
    };
  },
});
