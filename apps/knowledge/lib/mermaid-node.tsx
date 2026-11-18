"use client";
/**
 * The Mermaid block in the editor (#360): an atom node whose source and text description are attributes, edited in
 * place with a live preview. Stored and rendered through lib/doc.ts like every other node.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { MermaidDiagram } from "@/components/MermaidDiagram";
import { checkMermaid, LIMITS } from "./doc";
import { ERRORS } from "./messages";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mermaid: { insertMermaid: (attrs: { source: string; description?: string }) => ReturnType };
  }
}

function MermaidView({ node, updateAttributes, editor, deleteNode }: ReactNodeViewProps) {
  const source = String(node.attrs.source ?? "");
  const description = String(node.attrs.description ?? "");
  const [preview, setPreview] = useState(source);
  const check = checkMermaid(source);
  return (
    <NodeViewWrapper className="mermaid-block" data-testid="mermaid-block">
      <div className="mermaid-head">
        <strong>Diagram (Mermaid)</strong>
        {editor.isEditable ? (
          <button type="button" className="tool" onClick={() => deleteNode()}>
            Remove
          </button>
        ) : null}
      </div>
      <label>
        Source
        <textarea
          className="mono"
          rows={Math.min(14, Math.max(4, source.split("\n").length + 1))}
          maxLength={LIMITS.mermaid}
          value={source}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ source: e.target.value })}
          onBlur={() => setPreview(source)}
          data-testid="mermaid-source"
        />
      </label>
      {!check.ok ? (
        <p className="notice bad" role="alert">
          {ERRORS[check.error] ?? check.error}
        </p>
      ) : null}
      <label>
        Text description (for readers who can&apos;t see the diagram)
        <input
          value={description}
          maxLength={LIMITS.mermaidDescription}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ description: e.target.value })}
          data-testid="mermaid-description"
        />
      </label>
      <div contentEditable={false}>
        <MermaidDiagram source={preview} description={description} />
      </div>
    </NodeViewWrapper>
  );
}

export const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { source: { default: 'flowchart TD\n  A["Start"] --> B["End"]' }, description: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "figure[data-mermaid]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-mermaid": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MermaidView);
  },
  addCommands() {
    return {
      insertMermaid:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
