"use client";
/**
 * The workflow builder: palette and node list (left), canvas (middle), the selected node's settings
 * (right), over the draft definition itself. Every edit is a function of lib/builder/ops.ts on the
 * draft; the draft is saved on its own a moment after the last change ("Saved" / "Unsaved changes"),
 * naming the save it started from, so a save over someone else's is refused, not made. Validate and
 * Publish ask the server, which refuses to publish while there is a problem; the problems are shown on
 * their nodes. Test run starts a run of the saved draft (a dry run unless unticked) and opens it.
 *
 * Read-only without flow.workflows.write, and on a phone (narrower than 640 px), where it says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  importWorkflowFileAction,
  publishDraft,
  saveDraft,
  testDraft,
  validateDraft,
  type DraftResult,
} from "@/app/actions";
import { moveNode, nodeIds, toCanvas, TRIGGER_ID } from "@/lib/builder/canvas";
import { exportWorkflowFile, WORKFLOW_FILE_MAX_BYTES } from "@/lib/builder/file";
import { keyOf, orderOf } from "@/lib/builder/graph";
import {
  addNode,
  connect,
  deleteNode,
  newNode,
  newTrigger,
  renameNode,
  setTrigger,
  updateNode,
} from "@/lib/builder/ops";
import { fieldProblemText, problemsByPlace, WORKFLOW } from "@/lib/builder/problems";
import { suggestionsFor, triggerExample } from "@/lib/builder/suggest";
import type { Catalog, CredentialRef, Draft, NodeSpec, Problem } from "@/lib/builder/types";
import {
  workflowDiagram,
  workflowOutline,
  WORKFLOW_DIAGRAM_NODE_HEIGHT,
  WORKFLOW_DIAGRAM_NODE_WIDTH,
} from "@/lib/builder/visual";
import { Canvas } from "./Canvas";
import { NodeList, Palette } from "./Palette";
import { NodeSettings, TriggerSettings } from "./Settings";

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "failed";

const AUTOSAVE_MS = 800;
const PHONE = "(max-width: 640px)";

const STATUS: Record<SaveState, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  conflict: "Not saved: someone else changed this draft",
  failed: "Not saved",
};

const REFUSALS: Record<string, string> = {
  forbidden: "You don't have the permission flow.workflows.write.",
  invalid_input: "That doesn't fit (the trigger data must be a JSON object).",
  invalid_draft: "The draft is too large to save (256 KiB at most).",
  stale_draft: "Someone else saved this draft since you opened it.",
  invalid_definition: "Not published: fix the problems shown on the nodes first.",
  no_draft: "There is no draft: nothing changed since the last version.",
  not_found: "This workflow doesn't exist any more.",
  paused_all: "All of Flow is paused (Settings): only a dry run can start.",
  app_inactive: "The app isn't active.",
  unauthenticated: "Your session ended: sign in again.",
  permissions_unavailable: "Permissions can't be checked right now.",
};
const refusal = (r: DraftResult) => REFUSALS[r.error ?? ""] ?? "Something went wrong.";

function usePhone(): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = window.matchMedia(PHONE);
      m.addEventListener("change", change);
      return () => m.removeEventListener("change", change);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

export interface BuilderProps {
  workflowKey: string;
  name: string;
  initial: Draft;
  /** What it opened: the draft, the published version (a v1 one converted), or a new workflow's start. */
  from: "draft" | "version" | "v1" | "new";
  /** When the draft it opened was saved (null: no draft yet), ISO 8601. */
  lastSeen: string | null;
  catalog: Catalog;
  credentials: readonly CredentialRef[];
  problems: readonly Problem[];
  canWrite: boolean;
  /** The latest published version's number, if any. */
  published: number | null;
  /** This workflow's hook, which a webhook or GitHub trigger names; null without one. */
  hookId: string | null;
  /** Shown in the trigger's settings by trigger type: the hook's panel (components/HookPanel.tsx). */
  triggerPanels?: Partial<Record<string, React.ReactNode>>;
}

export function Builder(props: BuilderProps) {
  const { workflowKey, catalog, credentials } = props;
  const phone = usePhone();
  const editable = props.canWrite && !phone;
  const [draft, setDraft] = useState<Draft>(props.initial);
  const [selected, setSelected] = useState<string | null>(TRIGGER_ID);
  const [problems, setProblems] = useState<readonly Problem[]>(props.problems);
  const [save, setSave] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [published, setPublished] = useState(props.published);
  const [busy, setBusy] = useState(false);
  const [importRaw, setImportRaw] = useState<string | null>(null);
  const [importName, setImportName] = useState("");
  const [importKey, setImportKey] = useState("");
  const [importFeedback, setImportFeedback] = useState<{ error: string; problems?: string[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const importPanelRef = useRef<HTMLDetailsElement>(null);
  const diagramRef = useRef<SVGSVGElement>(null);

  const latest = useRef(draft);
  const savedJson = useRef(JSON.stringify(props.initial));
  const lastSeen = useRef(props.lastSeen);
  const conflict = useRef(false);
  const inflight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Save the draft as it is now, after any save in flight; true once what is shown is saved. `force`:
   * save it even unchanged when there is no draft (after a publish), for a test run, which runs one.
   */
  const flush = useCallback(
    async (force = false): Promise<boolean> => {
      clearTimeout(timer.current);
      while (inflight.current) await inflight.current;
      if (conflict.current) return false;
      const d = latest.current;
      const json = JSON.stringify(d);
      if (json === savedJson.current && !(force && lastSeen.current === null)) return true;
      setSave("saving");
      const run = (async () => {
        try {
          const r = await saveDraft(workflowKey, d, lastSeen.current);
          if (r.ok) {
            lastSeen.current = r.draftUpdatedAt ?? null;
            savedJson.current = json;
            setProblems(r.problems ?? []);
            return true;
          }
          if (r.error === "stale_draft") {
            conflict.current = true;
            setSave("conflict");
          } else {
            setSave("failed");
            setNotice({ kind: "bad", text: refusal(r) });
          }
          return false;
        } catch {
          setSave("failed");
          setNotice({ kind: "bad", text: "The draft couldn't be saved: check your connection, then edit again." });
          return false;
        }
      })();
      inflight.current = run;
      const ok = await run;
      inflight.current = null;
      if (ok) {
        const more = JSON.stringify(latest.current) !== savedJson.current;
        setSave(more ? "unsaved" : "saved");
        if (more) timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
      }
      return ok && JSON.stringify(latest.current) === savedJson.current;
    },
    [workflowKey],
  );

  useEffect(() => {
    latest.current = draft;
    if (conflict.current || JSON.stringify(draft) === savedJson.current) return;
    setSave((s) => (s === "saving" ? s : "unsaved"));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [draft, flush]);

  useEffect(() => {
    if (save === "saved") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);

  const edit = (fn: (d: Draft) => Draft) => {
    if (editable) setDraft((d) => fn(d));
  };

  const ids = useMemo(() => nodeIds(draft), [draft]);
  const order = useMemo(() => {
    const byKey = orderOf(draft);
    const keyed = byKey.map((k) => ids[draft.nodes.findIndex((n) => keyOf(n) === k)]!).filter(Boolean);
    return [...new Set([...keyed, ...ids])];
  }, [draft, ids]);
  const byPlace = useMemo(() => problemsByPlace(draft, problems), [draft, problems]);
  const counts = useMemo(() => new Map([...byPlace].map(([k, v]) => [k, v.length])), [byPlace]);
  const index = selected && selected !== TRIGGER_ID ? ids.indexOf(selected) : -1;
  const node = index >= 0 ? draft.nodes[index] : undefined;
  const current = selected === TRIGGER_ID || node ? selected : null;
  const suggestions = useMemo(
    () => suggestionsFor(draft, node ? keyOf(node) : undefined, catalog),
    [draft, node, catalog],
  );
  const diagram = useMemo(() => workflowDiagram(draft), [draft]);
  const outline = useMemo(() => workflowOutline(draft), [draft]);

  function downloadFile(name: string, contents: BlobPart, type: string) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onExport() {
    const file = exportWorkflowFile(draft, catalog);
    downloadFile(`${workflowKey}.flow.json`, `${JSON.stringify(file, null, 2)}\n`, "application/json");
  }

  function onDownloadImage() {
    const svg = diagramRef.current;
    if (!svg) return;
    const source = new XMLSerializer().serializeToString(svg);
    downloadFile(`${workflowKey}.svg`, source, "image/svg+xml;charset=utf-8");
  }

  async function onImportFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setImportRaw(null);
    setImportFeedback(null);
    if (!file) return;
    if (importPanelRef.current) importPanelRef.current.open = true;
    if (file.size > WORKFLOW_FILE_MAX_BYTES) {
      setImportFeedback({ error: "The workflow file is too large (256 KiB maximum)." });
      return;
    }
    let raw: string;
    try {
      raw = await file.text();
    } catch {
      setImportFeedback({ error: "The selected file couldn't be read." });
      return;
    }
    try {
      JSON.parse(raw);
    } catch {
      setImportFeedback({ error: "The selected file isn't valid JSON." });
      return;
    }
    const baseName = file.name.replace(/(?:\.flow)?\.json$/i, "").replace(/[-_]+/g, " ").trim();
    const safeStem = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const importedKey = `${(safeStem || "imported-workflow").slice(0, 57).replace(/-+$/, "")}-import`;
    setImportRaw(raw);
    setImportName(baseName.slice(0, 200) || "Imported workflow");
    setImportKey(importedKey);
    if (importPanelRef.current) importPanelRef.current.open = true;
  }

  async function onImportSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!importRaw) {
      setImportFeedback({ error: "Choose a valid workflow file first." });
      return;
    }
    setImporting(true);
    try {
      const result = await importWorkflowFileAction(importName, importKey, importRaw);
      if (!result.ok) {
        setImportFeedback({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) });
        return;
      }
      window.location.assign(`/workflows/${result.workflowKey}/edit`);
    } catch {
      setImportFeedback({ error: "The workflow couldn't be imported. Check your connection and try again." });
    } finally {
      setImporting(false);
    }
  }

  const add = (spec: NodeSpec) => {
    if (!editable) return;
    const n = newNode(draft, spec, credentials);
    const after = current ?? TRIGGER_ID;
    const at = toCanvas(draft).nodes.find((c) => c.id === after)?.position;
    setDraft(addNode(draft, n, spec, after, at ? { x: at.x, y: at.y + 140 } : undefined));
    setSelected(n.key as string);
    setNotice({
      kind: "good",
      text: `Added ${n.key as string} after ${after === TRIGGER_ID ? "the trigger" : after}.`,
    });
  };

  const remove = (id: string) => {
    if (!editable) return;
    setDraft((d) => deleteNode(d, id));
    setSelected(TRIGGER_ID);
    setNotice({ kind: "good", text: `Deleted ${id}.` });
  };

  const changeTrigger = (type: string) => {
    const spec = catalog.triggers.find((t) => t.type === type);
    if (spec && spec.type !== draft.trigger.type) {
      const trigger = newTrigger(spec);
      // A webhook or GitHub trigger names the workflow's hook, if it has one.
      if ("hook" in trigger && props.hookId) trigger.hook = props.hookId;
      edit((d) => setTrigger(d, trigger));
    }
    setSelected(TRIGGER_ID);
  };

  async function onValidate() {
    setBusy(true);
    try {
      await flush();
      const r = await validateDraft(workflowKey, latest.current);
      if (!r.ok) return setNotice({ kind: "bad", text: refusal(r) });
      setProblems(r.problems ?? []);
      const n = r.problems?.length ?? 0;
      setNotice(
        n
          ? { kind: "bad", text: `${n} problem${n === 1 ? "" : "s"}: each is shown on its node.` }
          : { kind: "good", text: "No problems: it can be published." },
      );
    } finally {
      setBusy(false);
    }
  }

  async function onPublish() {
    setBusy(true);
    try {
      if (!(await flush())) return setNotice({ kind: "bad", text: "Not published: the draft isn't saved." });
      const r = await publishDraft(workflowKey);
      if (r.problems) setProblems(r.problems);
      if (!r.ok) return setNotice({ kind: "bad", text: refusal(r) });
      // Published: the draft is gone, the next edit starts a new one.
      lastSeen.current = null;
      setPublished(r.version ?? null);
      setProblems([]);
      setNotice({ kind: "good", text: `Published version ${r.version}: new runs start on it.` });
    } finally {
      setBusy(false);
    }
  }

  const [testData, setTestData] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(true);
  async function onTest(e: React.FormEvent) {
    e.preventDefault();
    let data: unknown;
    try {
      data = JSON.parse(testData ?? "{}");
    } catch {
      return setNotice({ kind: "bad", text: "The trigger data isn't JSON." });
    }
    setBusy(true);
    try {
      if (!(await flush(true))) return setNotice({ kind: "bad", text: "No test run: the draft isn't saved." });
      const r = await testDraft(workflowKey, data, dryRun);
      if (r.problems) setProblems(r.problems);
      if (!r.ok || !r.runId) return setNotice({ kind: "bad", text: refusal(r) });
      window.location.assign(`/runs/${r.runId}`);
    } finally {
      setBusy(false);
    }
  }

  const general = byPlace.get(WORKFLOW) ?? [];
  const afterLabel = current === TRIGGER_ID || !current ? "the trigger" : current;

  return (
    <div className="builder" data-testid="builder" data-editable={editable}>
      <header className="builder-bar">
        <div>
          <h1>{props.name}</h1>
          <p className="muted">
            <span className="mono">{workflowKey}</span>
            {published ? <> · version {published} is published</> : <> · not published yet</>}
            {props.from === "version" || props.from === "v1" ? (
              <> · editing makes a draft; version {published} keeps running until you publish</>
            ) : null}
          </p>
        </div>
        <div className="builder-tools">
          <button type="button" className="secondary" onClick={onExport} data-testid="export-workflow">
            Export JSON
          </button>
          <button type="button" className="secondary" onClick={() => window.print()} data-testid="print-workflow">
            Print
          </button>
          <button type="button" className="secondary" onClick={onDownloadImage} data-testid="download-workflow-image">
            Download image
          </button>
          {editable ? (
            <button
              type="button"
              className="secondary"
              onClick={() => uploadRef.current?.click()}
              data-testid="import-workflow"
            >
              Import workflow
            </button>
          ) : null}
          <input
            ref={uploadRef}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            aria-label="Choose a workflow JSON file"
            onChange={onImportFileChange}
            data-testid="workflow-file-input"
          />
          {props.canWrite ? (
            <span className={`save-state ${save}`} role="status" aria-live="polite" data-testid="save-state">
              {STATUS[save]}
            </span>
          ) : null}
          {editable ? (
            <>
              <button type="button" className="secondary" onClick={onValidate} disabled={busy} data-testid="validate">
                Validate
              </button>
              <button type="button" onClick={onPublish} disabled={busy || save === "conflict"} data-testid="publish">
                Publish
              </button>
            </>
          ) : null}
          {props.published ? (
            <a className="button secondary" href={`/workflows/${workflowKey}/versions`}>
              Versions
            </a>
          ) : null}
        </div>
      </header>

      {editable ? (
        <details
          ref={importPanelRef}
          className="workflow-import"
          data-testid="workflow-import-panel"
        >
          <summary>Import a workflow as a new draft</summary>
          <form onSubmit={onImportSubmit}>
            <label htmlFor="workflow-import-name">New workflow name</label>
            <input
              id="workflow-import-name"
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
              maxLength={200}
              required
              data-testid="workflow-import-name"
            />
            <label htmlFor="workflow-import-key">New workflow key</label>
            <input
              id="workflow-import-key"
              value={importKey}
              onChange={(event) => setImportKey(event.target.value)}
              maxLength={64}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
              data-testid="workflow-import-key"
            />
            <p className="muted">
              Imports create a separate draft only. Credentials and webhook hooks are not copied; choose or create
              them after import.
            </p>
            {importRaw ? <p role="status">Workflow file ready to import.</p> : null}
            {importFeedback ? (
              <div className="notice bad" role="alert" data-testid="workflow-import-error">
                <p>{importFeedback.error}</p>
                {importFeedback.problems?.length ? (
                  <ul>
                    {importFeedback.problems.map((problem, index) => <li key={index}>{problem}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <button type="submit" disabled={!importRaw || importing} data-testid="confirm-workflow-import">
              {importing ? "Importing…" : "Create draft"}
            </button>
          </form>
        </details>
      ) : null}

      {phone && props.canWrite ? (
        <p className="notice warn" role="status" data-testid="phone-view-only">
          On a phone the builder is view-only. Open this page on a tablet or a computer to edit it.
        </p>
      ) : null}
      {!props.canWrite ? (
        <p className="notice" role="status">
          View only: editing needs the permission <span className="perm">flow.workflows.write</span>.
        </p>
      ) : null}
      {props.from === "v1" && editable ? (
        <p className="notice" role="status">
          This workflow&apos;s published version uses definition version 1. The builder edits it as version 2, which
          runs the same way.
        </p>
      ) : null}
      {save === "conflict" ? (
        <div className="notice bad" role="alert" data-testid="conflict">
          Someone else saved this draft since you opened it, so your changes weren&apos;t saved over theirs.{" "}
          <button type="button" className="secondary small" onClick={() => window.location.reload()}>
            Reload their version
          </button>
        </div>
      ) : null}
      <div
        aria-live="polite"
        role="status"
        className={notice ? `notice ${notice.kind === "bad" ? "bad" : ""}` : "visually-hidden"}
        data-testid="builder-notice"
      >
        {notice?.text}
      </div>
      {general.length ? (
        <div className="notice bad" data-testid="workflow-problems">
          <ul className="plain">
            {general.map((p, i) => (
              <li key={i}>{fieldProblemText(p)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="builder-grid">
        <aside className="builder-left">
          {editable ? (
            <Palette
              catalog={catalog}
              editable={editable}
              triggerType={String(draft.trigger.type ?? "")}
              onAdd={add}
              onTrigger={changeTrigger}
              after={afterLabel}
            />
          ) : null}
          <NodeList
            draft={draft}
            ids={ids}
            order={order}
            catalog={catalog}
            selected={current}
            problemCounts={counts}
            onSelect={setSelected}
          />
        </aside>

        <Canvas
          draft={draft}
          catalog={catalog}
          selected={current}
          problemCounts={counts}
          editable={editable}
          onSelect={setSelected}
          onMove={(id, at) => edit((d) => moveNode(d, id, at))}
          onConnect={(source, field, target) => edit((d) => connect(d, source, field, target))}
          onDelete={remove}
          onDisconnect={(source, field) => edit((d) => connect(d, source, field, ""))}
        />

        <aside className="builder-right" id="settings-panel" aria-label="Settings">
          {current === TRIGGER_ID ? (
            <TriggerSettings
              draft={draft}
              catalog={catalog}
              hookId={props.hookId}
              suggestions={suggestions}
              problems={byPlace.get(TRIGGER_ID) ?? []}
              editable={editable}
              onChange={(t) => edit((d) => setTrigger(d, t))}
              onType={changeTrigger}
              onStart={(k) => edit((d) => connect(d, TRIGGER_ID, "start", k))}
            >
              {props.triggerPanels?.[String(draft.trigger.type)]}
            </TriggerSettings>
          ) : node && current ? (
            <NodeSettings
              key={current}
              draft={draft}
              id={current}
              node={node}
              spec={catalog.nodes.find((s) => s.type === node.type)}
              credentials={credentials}
              suggestions={suggestions}
              problems={byPlace.get(current) ?? []}
              editable={editable}
              onChange={(n) => edit((d) => updateNode(d, current, n))}
              onRename={(k) => {
                edit((d) => renameNode(d, current, k));
                setSelected(k);
              }}
              onConnect={(field, target) => edit((d) => connect(d, current, field, target))}
              onDelete={() => remove(current)}
            />
          ) : (
            <p className="muted">Choose a node in the list or on the canvas to see its settings.</p>
          )}

          {editable ? (
            <details
              className="test-run"
              onToggle={(e) => {
                if ((e.currentTarget as HTMLDetailsElement).open && testData === null)
                  setTestData(JSON.stringify(triggerExample(draft), null, 2));
              }}
            >
              <summary data-testid="test-run-open">Test run</summary>
              <form onSubmit={onTest}>
                <label htmlFor="test-data">Trigger data (JSON)</label>
                <textarea
                  id="test-data"
                  className="mono"
                  rows={8}
                  spellCheck={false}
                  value={testData ?? ""}
                  onChange={(e) => setTestData(e.target.value)}
                  data-testid="test-data"
                />
                <p className="check">
                  <input
                    id="dry-run"
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    data-testid="dry-run"
                  />
                  <label htmlFor="dry-run">Dry run: nothing is sent, each step records what it would do</label>
                </p>
                <div className="actions">
                  <button type="submit" disabled={busy} data-testid="test-run">
                    Start the test run
                  </button>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => setTestData(JSON.stringify(triggerExample(draft), null, 2))}
                  >
                    Reset to the example
                  </button>
                </div>
              </form>
            </details>
          ) : null}
        </aside>
      </div>
      <details className="workflow-visual" data-testid="workflow-visual">
        <summary>Print and accessible workflow outline</summary>
        <div className="workflow-print-layout">
          <div className="workflow-diagram-wrap">
            <svg
              ref={diagramRef}
              className="workflow-diagram"
              viewBox={`0 0 ${diagram.width} ${diagram.height}`}
              width={diagram.width}
              height={diagram.height}
              role="img"
              aria-labelledby="workflow-diagram-title workflow-diagram-description"
              xmlns="http://www.w3.org/2000/svg"
              data-testid="workflow-diagram"
            >
              <title id="workflow-diagram-title">{props.name} workflow</title>
              <desc id="workflow-diagram-description">
                Workflow chart with {diagram.nodes.length} nodes and {diagram.edges.length} connections.
              </desc>
              <defs>
                <marker
                  id="workflow-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563" />
                </marker>
              </defs>
              {diagram.edges.map((edge, index) => {
                const from = diagram.nodes.find((item) => item.id === edge.source);
                const to = diagram.nodes.find((item) => item.id === edge.target);
                if (!from || !to) return null;
                const x1 = from.x + WORKFLOW_DIAGRAM_NODE_WIDTH / 2;
                const y1 = from.y + WORKFLOW_DIAGRAM_NODE_HEIGHT / 2;
                const x2 = to.x + WORKFLOW_DIAGRAM_NODE_WIDTH / 2;
                const y2 = to.y + WORKFLOW_DIAGRAM_NODE_HEIGHT / 2;
                return (
                  <g key={`${edge.source}-${edge.target}-${index}`} className="workflow-diagram-edge">
                    <path
                      d={`M ${x1} ${y1} C ${x1 + 36} ${y1}, ${x2 - 36} ${y2}, ${x2} ${y2}`}
                      markerEnd="url(#workflow-arrow)"
                      fill="none"
                      stroke="#4b5563"
                      strokeWidth={2}
                    />
                    {edge.label ? (
                      <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7} fill="#374151">
                        {edge.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {diagram.nodes.map((item) => (
                <g key={item.id} className="workflow-diagram-node">
                  <rect
                    x={item.x}
                    y={item.y}
                    width={WORKFLOW_DIAGRAM_NODE_WIDTH}
                    height={WORKFLOW_DIAGRAM_NODE_HEIGHT}
                    rx={10}
                    fill="white"
                    stroke="#4b5563"
                    strokeWidth={2}
                  />
                  <text x={item.x + 12} y={item.y + 29} className="workflow-diagram-title" fill="#111827">
                    {item.title}
                  </text>
                  <text x={item.x + 12} y={item.y + 50} className="workflow-diagram-type" fill="#4b5563">
                    {item.type}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <section className="workflow-outline-section" aria-labelledby="workflow-outline-heading">
            <h2 id="workflow-outline-heading">Workflow outline</h2>
            <pre className="workflow-outline" aria-label="Numbered workflow outline">{outline.join("\n")}</pre>
          </section>
        </div>
      </details>
    </div>
  );
}
