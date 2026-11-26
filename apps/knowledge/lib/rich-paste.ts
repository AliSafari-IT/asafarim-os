"use client";
/**
 * The editor's paste and drop handling (lib/paste.ts has the rules). Pasted HTML is normalised before the editor
 * reads it; a pasted or dropped image file (a screenshot, Chrome's "Copy image") goes through the normal upload.
 * When the clipboard holds text as well as a picture (Word and some sites add a picture of the selection), the text
 * wins: that is what the author meant to paste.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { MEDIA_TYPES } from "./media/validate";
import { hasText, normalizePastedHtml } from "./paste";

export interface RichPasteOptions {
  /** Called with the image files pasted or dropped; absent when uploads are off (the files are then ignored). */
  onImageFiles: ((files: File[]) => void) | null;
  /** Called after a paste that took out images from another site. */
  onDroppedImages: ((count: number) => void) | null;
}

const isImage = (f: File) => f.type in MEDIA_TYPES && MEDIA_TYPES[f.type as keyof typeof MEDIA_TYPES].kind === "image";

const imagesOf = (data: DataTransfer | null): File[] => [...(data?.files ?? [])].filter(isImage);

export const RichPaste = Extension.create<RichPasteOptions>({
  name: "richPaste",
  addOptions: () => ({ onImageFiles: null, onDroppedImages: null }),
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("richPaste"),
        props: {
          transformPastedHTML(html) {
            const r = normalizePastedHtml(html);
            if (r.droppedImages) options.onDroppedImages?.(r.droppedImages);
            return r.html;
          },
          handlePaste(_view, event) {
            const files = imagesOf(event.clipboardData);
            if (!files.length || !options.onImageFiles) return false;
            const html = event.clipboardData?.getData("text/html") ?? "";
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if ((html && hasText(html)) || (!html && text.trim())) return false;
            event.preventDefault();
            options.onImageFiles(files);
            return true;
          },
          handleDrop(view, event) {
            const files = imagesOf(event.dataTransfer);
            if (!files.length || !options.onImageFiles) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            // Insert where the file was dropped, not where the cursor happened to be.
            if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
            options.onImageFiles(files);
            return true;
          },
        },
      }),
    ];
  },
});
