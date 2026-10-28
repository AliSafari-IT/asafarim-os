"use client";
/**
 * The canvas: React Flow drawing the draft (lib/builder/canvas.ts `toCanvas`). Zoom, pan and fit-view;
 * when editable, dragging a node moves it (its `layout` only, saved when dropped), dragging from a
 * handle to a node connects them, Delete removes the selected node or edge. Each of these is also in
 * the node list and the settings panel, for the keyboard. React Flow's own stylesheet is its base one
 * (layout, no colours); the colours are the OS theme's tokens (app/workflows/builder.css).
 */
import {
  Background,
  Controls,
  Handle,
  Position as Side,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { memo, useMemo, useState } from "react";
import { deletion, START_HANDLE, toCanvas, TRIGGER_ID, type Position } from "@/lib/builder/canvas";
import type { Catalog, Draft, EdgeField } from "@/lib/builder/types";

interface StepData extends Record<string, unknown> {
  title: string;
  subtitle: string;
  problems: number;
  /** The handles it leaves by. */
  edges: (EdgeField | typeof START_HANDLE)[];
  target: boolean;
}

const HANDLE_X: Record<string, string> = { next: "50%", start: "50%", then: "30%", else: "70%" };

const StepNode = memo(function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  return (
    <div className={`flow-node${selected ? " selected" : ""}${data.problems ? " has-problems" : ""}`}>
      {data.target ? <Handle type="target" position={Side.Top} /> : null}
      <div className="flow-node-title">{data.title}</div>
      <div className="flow-node-sub mono">{data.subtitle}</div>
      {data.problems ? (
        <div className="flow-node-problems">
          {data.problems} problem{data.problems === 1 ? "" : "s"}
        </div>
      ) : null}
      {data.edges.map((h) => (
        <Handle key={h} type="source" id={h} position={Side.Bottom} style={{ left: HANDLE_X[h] }} title={h} />
      ))}
      {data.edges.length > 1 ? (
        <div className="flow-node-branches" aria-hidden="true">
          {data.edges.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const NODE_TYPES = { trigger: StepNode, step: StepNode };

export function Canvas({
  draft,
  catalog,
  selected,
  problemCounts,
  editable,
  onSelect,
  onMove,
  onConnect,
  onDelete,
  onDisconnect,
}: {
  draft: Draft;
  catalog: Catalog;
  selected: string | null;
  problemCounts: Map<string, number>;
  editable: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Position) => void;
  onConnect: (source: string, field: EdgeField | "start", target: string) => void;
  onDelete: (id: string) => void;
  onDisconnect: (source: string, field: EdgeField | "start") => void;
}) {
  const canvas = useMemo(() => toCanvas(draft), [draft]);
  // Where a node is while it is dragged; the draft's layout changes when it is dropped.
  const [dragging, setDragging] = useState<Record<string, Position>>({});
  // Each node's size as React Flow measured it, handed back on every render (the nodes are rebuilt
  // from the draft); never part of the draft: its layout holds positions only.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});

  const nodes: Node<StepData>[] = canvas.nodes.map((c) => {
    if (c.type === "trigger") {
      const type = String(c.data.trigger?.type ?? "");
      return {
        id: c.id,
        type: "trigger",
        position: dragging[c.id] ?? c.position,
        ...(measured[c.id] ? { measured: measured[c.id] } : {}),
        selected: selected === c.id,
        deletable: false,
        ariaLabel: `Trigger: ${catalog.triggers.find((t) => t.type === type)?.label ?? type}`,
        data: {
          title: "Trigger",
          subtitle: catalog.triggers.find((t) => t.type === type)?.label ?? type,
          problems: problemCounts.get(c.id) ?? 0,
          edges: [START_HANDLE],
          target: false,
        },
      };
    }
    const node = c.data.node ?? {};
    const spec = catalog.nodes.find((s) => s.type === node.type);
    const key = typeof node.key === "string" ? node.key : c.id;
    return {
      id: c.id,
      type: "step",
      position: dragging[c.id] ?? c.position,
      ...(measured[c.id] ? { measured: measured[c.id] } : {}),
      selected: selected === c.id,
      deletable: editable,
      ariaLabel: `${spec?.label ?? String(node.type)}: ${key}`,
      data: {
        title: spec?.label ?? String(node.type ?? "?"),
        subtitle: key,
        problems: problemCounts.get(c.id) ?? 0,
        edges: spec?.edges ?? ["next"],
        target: true,
      },
    };
  });
  const edges: Edge[] = canvas.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    label: e.sourceHandle === "then" || e.sourceHandle === "else" ? e.sourceHandle : undefined,
    deletable: editable,
  }));

  const onNodesChange = (changes: NodeChange<Node<StepData>>[]) => {
    for (const c of changes) {
      if (c.type === "position") {
        const at = c.position ?? dragging[c.id];
        if (c.dragging) {
          if (at) setDragging((d) => ({ ...d, [c.id]: at }));
        } else if (at) {
          // Dropped, or moved with the arrow keys: into the draft's layout.
          setDragging(({ [c.id]: _done, ...rest }) => rest);
          onMove(c.id, at);
        }
      } else if (c.type === "dimensions" && c.dimensions) {
        const size = c.dimensions;
        setMeasured((m) =>
          m[c.id]?.width === size.width && m[c.id]?.height === size.height ? m : { ...m, [c.id]: size },
        );
      } else if (c.type === "select" && c.selected) onSelect(c.id);
    }
  };

  return (
    <div className="flow-canvas" data-testid="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onPaneClick={() => onSelect(null)}
        onConnect={(c: Connection) => {
          if (c.source && c.target && c.target !== TRIGGER_ID)
            onConnect(c.source, (c.sourceHandle ?? "next") as EdgeField | "start", c.target);
        }}
        isValidConnection={(c) => c.source !== c.target && c.target !== TRIGGER_ID}
        onDelete={({ nodes: goneNodes, edges: goneEdges }) => {
          // A deleted node's edges come along: they are its to rejoin, not removed on their own first.
          const d = deletion(goneNodes, goneEdges);
          d.edges.forEach((e) => onDisconnect(e.source, e.field));
          d.nodes.forEach(onDelete);
        }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        fitView
        minZoom={0.2}
        maxZoom={2}
        ariaLabelConfig={{
          "node.a11yDescription.default": "Press Enter or Space to select the node; its settings are in the panel.",
        }}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
