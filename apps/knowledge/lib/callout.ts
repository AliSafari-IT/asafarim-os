/**
 * The callout block (note / tip / warning) for the editor: a Tiptap node whose kind is one attribute and whose
 * content is ordinary blocks. Rendered on the server by components/DocView.tsx, never from the editor's HTML.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { CALLOUT_KINDS } from "./doc";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: { toggleCallout: (kind: (typeof CALLOUT_KINDS)[number]) => ReturnType };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (el) => {
          const k = el.getAttribute("data-kind");
          return CALLOUT_KINDS.includes(k as never) ? k : "note";
        },
        renderHTML: (attrs) => ({ "data-kind": attrs.kind }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "aside[data-callout]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes, { "data-callout": "", class: "callout" }), 0];
  },
  addCommands() {
    return {
      toggleCallout:
        (kind) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { kind }),
    };
  },
});
