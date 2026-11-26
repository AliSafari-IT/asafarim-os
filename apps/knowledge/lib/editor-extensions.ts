/**
 * The editor's text extensions (#356), shared by the editor (components/EditorForm.tsx) and the paste tests: the
 * nodes and marks lib/doc.ts accepts, except the custom blocks (callout, Mermaid, media) which carry their own
 * React views. Highlight, subscript, superscript and alignment are here so text pasted from another page keeps
 * them; lib/doc.ts checks them again on save.
 */
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import StarterKit from "@tiptap/starter-kit";
import { safeHref } from "./doc";
import { EDITOR_HEADING_LEVELS } from "./paste";

export const textExtensions = () => [
  StarterKit.configure({
    heading: { levels: [...EDITOR_HEADING_LEVELS] },
    link: { openOnClick: false, autolink: true, isAllowedUri: (url) => safeHref(url) !== null },
  }),
  TableKit.configure({ table: { resizable: false } }),
  Highlight,
  Subscript,
  Superscript,
  TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
];
