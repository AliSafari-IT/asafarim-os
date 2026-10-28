"use client";
/**
 * The left column: the palette and the node list. The palette is the catalog's node types by group
 * (Triggers, Logic, Email, GitHub, Webhooks, Docs: from the connector registry and the v2 node
 * types); a type's button adds a node after the selected one (or the trigger). The node list is every
 * node in the order a run reaches them, each a button that selects it for the settings panel, with its
 * problem count: the way to every node without the canvas.
 */
import { TRIGGER_ID } from "@/lib/builder/canvas";
import { keyOf } from "@/lib/builder/graph";
import type { Catalog, Draft, NodeSpec } from "@/lib/builder/types";

export const GROUP_ORDER = ["Triggers", "Logic", "Email", "GitHub", "Webhooks", "Docs"];

export function Palette({
  catalog,
  editable,
  triggerType,
  onAdd,
  onTrigger,
  after,
}: {
  catalog: Catalog;
  editable: boolean;
  triggerType: string;
  onAdd: (spec: NodeSpec) => void;
  onTrigger: (type: string) => void;
  /** What a new node goes after: shown so the keyboard user knows. */
  after: string;
}) {
  const groups = [...new Set([...GROUP_ORDER, ...catalog.nodes.map((n) => n.group)])];
  return (
    <section aria-labelledby="palette-h" className="palette" data-testid="palette">
      <h2 id="palette-h">Add</h2>
      <p className="muted hint">New nodes go after {after}.</p>
      {groups.map((group) => {
        if (group === "Triggers")
          return (
            <div key={group} className="palette-group" role="group" aria-labelledby="palette-triggers">
              <h3 id="palette-triggers">Triggers</h3>
              {catalog.triggers.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  className="palette-item"
                  aria-pressed={triggerType === t.type}
                  disabled={!editable}
                  onClick={() => onTrigger(t.type)}
                  data-testid={`palette-trigger-${t.type}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          );
        const specs = catalog.nodes.filter((n) => n.group === group);
        if (!specs.length) return null;
        const id = `palette-${group.toLowerCase()}`;
        return (
          <div key={group} className="palette-group" role="group" aria-labelledby={id}>
            <h3 id={id}>{group}</h3>
            {specs.map((spec) => (
              <button
                key={spec.type}
                type="button"
                className="palette-item"
                disabled={!editable}
                onClick={() => onAdd(spec)}
                aria-label={`Add ${spec.label}`}
                data-testid={`palette-${spec.type}`}
              >
                {spec.label}
              </button>
            ))}
          </div>
        );
      })}
    </section>
  );
}

export function NodeList({
  draft,
  ids,
  order,
  catalog,
  selected,
  problemCounts,
  onSelect,
}: {
  draft: Draft;
  /** Each node's canvas id, by index. */
  ids: readonly string[];
  /** The canvas ids in the order a run reaches them. */
  order: readonly string[];
  catalog: Catalog;
  selected: string | null;
  problemCounts: Map<string, number>;
  onSelect: (id: string) => void;
}) {
  const triggerLabel = catalog.triggers.find((t) => t.type === draft.trigger.type)?.label ?? "Trigger";
  const rows = [
    { id: TRIGGER_ID, label: "Trigger", sub: triggerLabel },
    ...order.map((id) => {
      const node = draft.nodes[ids.indexOf(id)] ?? {};
      return {
        id,
        label: keyOf(node) ?? id,
        sub: catalog.nodes.find((s) => s.type === node.type)?.label ?? String(node.type ?? "?"),
      };
    }),
  ];
  return (
    <nav aria-labelledby="nodes-h" className="node-list" data-testid="node-list">
      <h2 id="nodes-h">Nodes</h2>
      <ol>
        {rows.map((r) => {
          const n = problemCounts.get(r.id) ?? 0;
          return (
            <li key={r.id}>
              <button
                type="button"
                aria-current={selected === r.id ? "true" : undefined}
                aria-controls="settings-panel"
                onClick={() => onSelect(r.id)}
                data-testid="node-list-item"
                data-node={r.id}
              >
                <span className="mono">{r.label}</span> <span className="muted">{r.sub}</span>
                {n ? (
                  <span className="badge bad" aria-label={`${n} problem${n === 1 ? "" : "s"}`}>
                    {n}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
