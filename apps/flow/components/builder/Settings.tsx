"use client";
/**
 * The settings panel: the selected node's (or the trigger's) form. A node's key (renaming it carries
 * what reads it along), its settings (components/builder/SchemaForm.tsx, from its schema; a
 * condition's clauses as field / op / value rows; an approval's draft and an issue's approval as
 * pickers of the nodes that fit), where it goes next (`next`, or `then` and `else`), its problems, and
 * Delete. Everything here is reachable and editable from the keyboard: the canvas is never needed.
 */
import { useEffect, useId, useState } from "react";
import { TRIGGER_ID } from "@/lib/builder/canvas";
import { keyOf } from "@/lib/builder/graph";
import { isNodeKey } from "@/lib/builder/ops";
import { fieldProblemText } from "@/lib/builder/problems";
import type { Suggestion } from "@/lib/builder/suggest";
import {
  EDGE_FIELDS,
  type Catalog,
  type CredentialRef,
  type Draft,
  type EdgeField,
  type NodeSpec,
  type Problem,
  type RawNode,
} from "@/lib/builder/types";
import { SchemaFields, type FormContext } from "./SchemaForm";

const EDGE_LABELS: Record<EdgeField, string> = {
  next: "Then go to",
  then: "When every clause holds, go to",
  else: "Otherwise, go to",
};

/** The problems the fields don't show: those on the node as a whole, or on a field it has no form for. */
function NodeProblems({ problems, shown }: { problems: readonly Problem[]; shown: (p: Problem) => boolean }) {
  const rest = problems.filter((p) => !shown(p));
  if (!rest.length) return null;
  return (
    <div className="notice bad" role="status" data-testid="node-problems">
      <ul className="plain">
        {rest.map((p, i) => (
          <li key={i}>{fieldProblemText(p)}</li>
        ))}
      </ul>
    </div>
  );
}

function NodeSelect({
  id,
  value,
  onChange,
  options,
  disabled,
  none,
}: {
  id: string;
  value: unknown;
  onChange: (v: string) => void;
  options: readonly string[];
  disabled: boolean;
  none: string;
}) {
  const v = typeof value === "string" ? value : "";
  return (
    <select id={id} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {options.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
      {v && !options.includes(v) ? <option value={v}>{v} (not a node)</option> : null}
    </select>
  );
}

/** A condition's clauses: a row each, field (with the paths it may read) / op / value. */
function Clauses({
  id,
  value,
  onChange,
  suggestions,
  editable,
  ops,
  problems,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  suggestions: readonly Suggestion[];
  editable: boolean;
  ops: readonly string[];
  problems: readonly Problem[];
}) {
  const rows = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const set = (i: number, patch: Record<string, unknown>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const listId = `${id}-fields`;
  return (
    <div>
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.path} value={s.path} />
        ))}
      </datalist>
      {rows.map((row, i) => {
        const kind =
          row.value === null
            ? "null"
            : typeof row.value === "boolean"
              ? String(row.value)
              : typeof row.value === "number"
                ? "number"
                : "text";
        const rowProblems = problems.filter((p) => p.path === `all.${i}` || p.path.startsWith(`all.${i}.`));
        return (
          <fieldset key={i} className="clause" data-testid="clause">
            <legend>Clause {i + 1}</legend>
            <label htmlFor={`${id}-${i}-field`}>Field</label>
            <input
              id={`${id}-${i}-field`}
              list={listId}
              value={typeof row.field === "string" ? row.field : ""}
              disabled={!editable}
              spellCheck={false}
              placeholder="trigger.… or steps.<key>.output.…"
              onChange={(e) => set(i, { field: e.target.value })}
            />
            <label htmlFor={`${id}-${i}-op`}>Op</label>
            <select
              id={`${id}-${i}-op`}
              value={String(row.op ?? "")}
              disabled={!editable}
              onChange={(e) => set(i, { op: e.target.value })}
            >
              {ops.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-${i}-kind`}>Value is</label>
            <select
              id={`${id}-${i}-kind`}
              value={kind}
              disabled={!editable}
              onChange={(e) => {
                const k = e.target.value;
                set(i, {
                  value:
                    k === "null"
                      ? null
                      : k === "true"
                        ? true
                        : k === "false"
                          ? false
                          : k === "number"
                            ? Number(row.value) || 0
                            : String(row.value ?? ""),
                });
              }}
            >
              <option value="text">text</option>
              <option value="number">a number</option>
              <option value="true">true</option>
              <option value="false">false</option>
              <option value="null">null</option>
            </select>
            {kind === "text" || kind === "number" ? (
              <>
                <label htmlFor={`${id}-${i}-value`}>Value</label>
                <input
                  id={`${id}-${i}-value`}
                  type={kind === "number" ? "number" : "text"}
                  step="any"
                  value={row.value === null || row.value === undefined ? "" : String(row.value)}
                  disabled={!editable}
                  onChange={(e) => set(i, { value: kind === "number" ? Number(e.target.value) : e.target.value })}
                />
              </>
            ) : null}
            {rowProblems.length ? (
              <ul className="field-problems">
                {rowProblems.map((p, j) => (
                  <li key={j}>{fieldProblemText(p)}</li>
                ))}
              </ul>
            ) : null}
            {editable ? (
              <button
                type="button"
                className="secondary small"
                disabled={rows.length <= 1}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                Remove clause {i + 1}
              </button>
            ) : null}
          </fieldset>
        );
      })}
      {editable ? (
        <button
          type="button"
          className="secondary small"
          onClick={() => onChange([...rows, { field: "", op: ops[0], value: "" }])}
        >
          Add a clause
        </button>
      ) : null}
    </div>
  );
}

/** The key, editable: applied on Enter or when the field is left, if it is a free kebab-case key. */
function KeyField({
  id,
  value,
  taken,
  editable,
  onRename,
}: {
  id: string;
  value: string;
  taken: (k: string) => boolean;
  editable: boolean;
  onRename: (k: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const error =
    text === value
      ? undefined
      : !isNodeKey(text)
        ? "lower case letters, digits and dashes, at most 40"
        : taken(text)
          ? "another node has this key"
          : undefined;
  const apply = () => {
    if (text !== value && !error) onRename(text);
  };
  return (
    <div className="field">
      <label htmlFor={id}>Key</label>
      <input
        id={id}
        value={text}
        disabled={!editable}
        spellCheck={false}
        maxLength={40}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        data-testid="node-key"
      />
      <p id={`${id}-hint`} className={error ? "field-problems" : "muted hint"}>
        {error ?? "What placeholders and conditions name it by: steps.<key>.output."}
      </p>
    </div>
  );
}

export function NodeSettings({
  draft,
  id,
  node,
  spec,
  credentials,
  suggestions,
  problems,
  editable,
  onChange,
  onRename,
  onConnect,
  onDelete,
}: {
  draft: Draft;
  id: string;
  node: RawNode;
  spec: NodeSpec | undefined;
  credentials: readonly CredentialRef[];
  suggestions: readonly Suggestion[];
  problems: readonly Problem[];
  editable: boolean;
  onChange: (node: RawNode) => void;
  onRename: (key: string) => void;
  onConnect: (field: EdgeField, target: string) => void;
  onDelete: () => void;
}) {
  const prefix = useId();
  const key = keyOf(node) ?? "";
  const others = draft.nodes.map(keyOf).filter((k): k is string => k !== undefined && k !== key);
  const ofType = (type: string) =>
    draft.nodes
      .filter((n) => n.type === type)
      .map(keyOf)
      .filter((k): k is string => !!k);
  const shown = new Set<string>();
  const settingsPath = spec?.connector ? "input" : "";
  for (const k of Object.keys(spec?.settings.properties ?? {})) shown.add(settingsPath ? `${settingsPath}.${k}` : k);
  const isShown = (p: Problem) =>
    [...shown].some((s) => p.path === s || p.path.startsWith(`${s}.`)) ||
    (spec?.edges ?? []).some((f) => p.path === f) ||
    p.path === "key";
  const opsEnum = (spec?.settings.properties?.all?.items?.properties?.op?.enum ?? []) as string[];
  const ctx: FormContext = {
    credentials,
    suggestions,
    editable,
    defs: spec?.settings.$defs,
    problems,
    custom: spec?.connector
      ? undefined
      : {
          all: (value, change, fid) => (
            <Clauses
              id={fid}
              value={value}
              onChange={change}
              suggestions={suggestions}
              editable={editable}
              ops={opsEnum}
              problems={problems}
            />
          ),
          ...(node.type === "approval"
            ? {
                draft: (value: unknown, change: (v: unknown) => void, fid: string) => (
                  <NodeSelect
                    id={fid}
                    value={value}
                    onChange={change}
                    options={ofType("docs.issue-draft")}
                    disabled={!editable}
                    none="— none: a plain approve or reject —"
                  />
                ),
              }
            : {}),
          ...(node.type === "docs.issue-create"
            ? {
                approval: (value: unknown, change: (v: unknown) => void, fid: string) => (
                  <NodeSelect
                    id={fid}
                    value={value}
                    onChange={change}
                    options={ofType("approval")}
                    disabled={!editable}
                    none="Choose the approval…"
                  />
                ),
              }
            : {}),
        },
  };

  return (
    <section aria-labelledby={`${prefix}-h`} data-testid="node-settings" data-node={id}>
      <h2 id={`${prefix}-h`}>
        {spec?.label ?? String(node.type ?? "A node")} <span className="mono muted">{key || id}</span>
      </h2>
      {!spec ? (
        <p className="notice warn">There is no node type {String(node.type)}: delete this node or fix its type.</p>
      ) : null}
      <KeyField
        id={`${prefix}-key`}
        value={key}
        taken={(k) => others.includes(k)}
        editable={editable}
        onRename={onRename}
      />
      {spec ? (
        <SchemaFields
          schema={spec.settings}
          value={spec.connector ? node.input : node}
          path={settingsPath}
          prefix={prefix}
          ctx={ctx}
          onChange={(v) =>
            onChange(
              spec.connector ? { ...node, input: v } : { ...v, key: node.key, type: node.type, ...edgesKept(node) },
            )
          }
        />
      ) : null}
      {(spec?.edges ?? []).map((f) => (
        <div className="field" key={f}>
          <label htmlFor={`${prefix}-${f}`}>{EDGE_LABELS[f]}</label>
          <NodeSelect
            id={`${prefix}-${f}`}
            value={node[f]}
            onChange={(t) => onConnect(f, t)}
            options={others}
            disabled={!editable}
            none="— not connected —"
          />
          {problems
            .filter((p) => p.path === f)
            .map((p, i) => (
              <p key={i} className="field-problems">
                {p.message}
              </p>
            ))}
        </div>
      ))}
      <NodeProblems problems={problems} shown={isShown} />
      {editable ? (
        <div className="actions">
          <button type="button" className="danger" onClick={onDelete} data-testid="delete-node">
            Delete {key || "this node"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** The node's edge fields, kept as they are when its settings change. */
const edgesKept = (node: RawNode) => Object.fromEntries(EDGE_FIELDS.filter((f) => f in node).map((f) => [f, node[f]]));

export function TriggerSettings({
  draft,
  catalog,
  suggestions,
  problems,
  editable,
  onChange,
  onType,
  onStart,
  children,
}: {
  draft: Draft;
  catalog: Catalog;
  suggestions: readonly Suggestion[];
  problems: readonly Problem[];
  editable: boolean;
  onChange: (trigger: Record<string, unknown>) => void;
  onType: (type: string) => void;
  onStart: (key: string) => void;
  /** More about the trigger (a webhook's hook). */
  children?: React.ReactNode;
}) {
  const prefix = useId();
  const spec = catalog.triggers.find((t) => t.type === draft.trigger.type);
  const keys = draft.nodes.map(keyOf).filter((k): k is string => k !== undefined);
  // The trigger's problems are at `trigger.<field>`; the start's at `start`.
  const relative = problems.map((p) => ({ ...p, path: p.path.replace(/^trigger\.?/, "") }));
  const ctx: FormContext = { credentials: [], suggestions, editable, defs: spec?.settings.$defs, problems: relative };
  const shownKeys = Object.keys(spec?.settings.properties ?? {});
  return (
    <section aria-labelledby={`${prefix}-h`} data-testid="node-settings" data-node={TRIGGER_ID}>
      <h2 id={`${prefix}-h`}>Trigger</h2>
      <div className="field">
        <label htmlFor={`${prefix}-type`}>Started by</label>
        <select
          id={`${prefix}-type`}
          value={String(draft.trigger.type ?? "")}
          disabled={!editable}
          onChange={(e) => onType(e.target.value)}
          data-testid="trigger-type"
        >
          {spec ? null : <option value="">—</option>}
          {catalog.triggers.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {spec ? (
        <SchemaFields
          schema={spec.settings}
          value={draft.trigger}
          path=""
          prefix={prefix}
          ctx={ctx}
          onChange={(v) => onChange({ ...v, type: spec.type })}
        />
      ) : null}
      {children}
      <div className="field">
        <label htmlFor={`${prefix}-start`}>First node</label>
        <NodeSelect
          id={`${prefix}-start`}
          value={draft.start}
          onChange={onStart}
          options={keys}
          disabled={!editable}
          none="— not connected —"
        />
      </div>
      <NodeProblems
        problems={relative}
        shown={(p) => p.path === "type" || shownKeys.some((k) => p.path === k || p.path.startsWith(`${k}.`))}
      />
    </section>
  );
}
