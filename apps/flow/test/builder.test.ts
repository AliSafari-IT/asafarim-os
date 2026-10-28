/**
 * The builder's library (lib/builder): the definition ⇄ canvas mapping (a lossless round trip; a move
 * changes `layout` only), the edits, the catalog made from the registry and the v2 schemas, the
 * checks that need Flow's data and where each problem goes, the placeholder suggestions (only steps
 * upstream on every path), v1 → v2, the versions diff, and publishing refused while a check finds a
 * problem (the real engine on the in-memory store).
 */
import { ulid } from "@asafarim/app-sdk/events";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../lib/builder/catalog";
import { fromCanvas, moveNode, nodeIds, toCanvas, TRIGGER_ID } from "../lib/builder/canvas";
import { dataProblems, type CheckData } from "../lib/builder/checks";
import { lineDiff, sortedJson } from "../lib/builder/diff";
import { upstreamOf } from "../lib/builder/graph";
import { openWorkflow } from "../lib/builder/open";
import { addNode, connect, deleteNode, newNode, renameNode, starterDraft, updateNode } from "../lib/builder/ops";
import { placeOf, problemsByPlace, WORKFLOW } from "../lib/builder/problems";
import { suggestionsFor, triggerExample } from "../lib/builder/suggest";
import type { Draft, NodeSpec } from "../lib/builder/types";
import { v1ToV2 } from "../lib/builder/v1";
import { createEngine } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import { parseDefinition } from "../lib/workflow/definition";
import { DOCS_NOTE_TO_ISSUE } from "../lib/workflow/seed";
import manifest from "../platform.app";
import { memoryDb } from "./memory-store";
import { clone, DOCS_FLOW, ECHO_FLOW } from "./v2-fixtures";

const draftOf = (v: unknown) => clone(v) as unknown as Draft;
const catalog = buildCatalog();
const spec = (type: string): NodeSpec => catalog.nodes.find((s) => s.type === type)!;

/** webhook → condition → email.send → end; the condition's else ends skipped. */
const NOTIFY: Draft = {
  version: 2,
  key: "notify",
  trigger: { type: "webhook", hook: "h".repeat(22), input: [{ name: "title", type: "string", required: true }] },
  start: "check",
  nodes: [
    {
      key: "check",
      type: "condition",
      all: [{ field: "trigger.title", op: "contains", value: "bug" }],
      then: "mail",
      else: "skip",
    },
    {
      key: "mail",
      type: "email.send",
      input: {
        credential: "cred-smtp",
        to: ["ops@example.com"],
        subject: "{{trigger.title}}",
        body: "New: {{trigger.title}}",
      },
      next: "done",
    },
    { key: "done", type: "end" },
    { key: "skip", type: "end", status: "skipped" },
  ],
};

const DATA: CheckData = {
  credentials: [
    { id: "cred-smtp", name: "Mail", kind: "smtp" },
    { id: "cred-gh", name: "GitHub bot", kind: "github-token" },
    { id: "cred-hook", name: "Hook secret", kind: "webhook-secret" },
  ],
  egressHosts: ["hooks.example.com", "alt.example.com:8443"],
  emailRecipients: ["ops@example.com", "@team.example.com"],
};

describe("definition ⇄ canvas", () => {
  it.each([
    ["a laid-out draft", ECHO_FLOW],
    ["a draft without layout", DOCS_FLOW],
    ["the builder's own example", NOTIFY],
  ])("round trip of %s: nothing lost, nothing added", (_, value) => {
    const draft = draftOf(value);
    expect(fromCanvas(draft, toCanvas(draft))).toEqual(draft);
  });

  it("round trip of a draft that doesn't validate: duplicate keys, an edge to no node, a start that isn't one", () => {
    const draft = draftOf({
      version: 2,
      key: "broken",
      trigger: { type: "manual", input: [] },
      start: "missing",
      nodes: [
        { key: "a", type: "condition", then: "b", else: "nowhere" },
        { key: "b", type: "end" },
        { key: "b", type: "wait", duration: "PT1M" },
        { type: "end" },
      ],
      extra: { kept: true },
    });
    const canvas = toCanvas(draft);
    expect(canvas.nodes.map((n) => n.id)).toEqual([TRIGGER_ID, "a", "#1", "#2", "#3"]);
    // "b" is two nodes: no edge can name either, so `then: "b"` stays as written and isn't drawn.
    expect(canvas.edges).toEqual([]);
    expect(fromCanvas(draft, canvas)).toEqual(draft);
  });

  it("nodes are the trigger and nodes[]; edges are start, next, then and else; positions come from layout", () => {
    const canvas = toCanvas(draftOf(ECHO_FLOW));
    expect(canvas.nodes.map((n) => [n.id, n.type, n.position])).toEqual([
      [TRIGGER_ID, "trigger", { x: 0, y: 0 }],
      ["check", "step", { x: 0, y: 0 }],
      ["shout", "step", { x: 200, y: 0 }],
      ["done", "step", { x: 400, y: 0 }],
    ]);
    expect(canvas.nodes[0]!.deletable).toBe(false);
    expect(canvas.edges.map((e) => [e.source, e.sourceHandle, e.target])).toEqual([
      [TRIGGER_ID, "start", "check"],
      ["check", "then", "shout"],
      ["check", "else", "done"],
      ["shout", "next", "done"],
    ]);
  });

  it("without a layout, each node gets a place by its distance from the trigger", () => {
    const canvas = toCanvas(draftOf(DOCS_FLOW));
    const y = Object.fromEntries(canvas.nodes.map((n) => [n.id, n.position.y]));
    expect(y[TRIGGER_ID]).toBeLessThan(y["only-tagged"]!);
    expect(y["only-tagged"]).toBeLessThan(y.draft!);
    expect(y.draft).toBe(y["not-tagged"]);
    expect(y.review).toBeLessThan(y.create!);
  });

  it("moving a node changes layout and nothing else", () => {
    for (const [value, id] of [
      [ECHO_FLOW, "done"],
      [DOCS_FLOW, "end"],
    ] as const) {
      const draft = draftOf(value);
      const moved = moveNode(draft, id, { x: 512.4, y: 300.6 });
      const { layout: a, ...restA } = moved;
      const { layout: b, ...restB } = draft;
      expect(restA).toEqual(restB);
      expect(a).toEqual({ ...b, [id]: { x: 512, y: 301 } });

      // The same through the canvas: one node dragged, then mapped back.
      const canvas = toCanvas(draft);
      const dragged = {
        ...canvas,
        nodes: canvas.nodes.map((n) => (n.id === id ? { ...n, position: { x: 512, y: 301 } } : n)),
      };
      const back = fromCanvas(draft, dragged);
      const { layout: c, ...restC } = back;
      expect(restC).toEqual(restB);
      expect(c).toEqual({ ...b, [id]: { x: 512, y: 301 } });
    }
  });

  it("an edge drawn on the canvas is the field it is", () => {
    const draft = draftOf(ECHO_FLOW);
    const canvas = toCanvas(draft);
    const rewired = {
      ...canvas,
      edges: canvas.edges.map((e) =>
        e.source === "check" && e.sourceHandle === "else" ? { ...e, target: "shout" } : e,
      ),
    };
    expect(fromCanvas(draft, rewired).nodes[0]).toEqual({ ...draft.nodes[0], else: "shout" });
  });
});

describe("the edits", () => {
  it("a node added after another takes its place in the chain", () => {
    const draft = draftOf(NOTIFY);
    const node = newNode(draft, spec("wait"));
    expect(node).toMatchObject({ key: "wait", type: "wait", duration: "PT1H" });
    const added = addNode(draft, node, spec("wait"), "mail");
    expect(added.nodes.find((n) => n.key === "mail")!.next).toBe("wait");
    expect(added.nodes.at(-1)).toEqual({ ...node, next: "done" });

    const first = addNode(draft, newNode(draft, spec("wait")), spec("wait"), TRIGGER_ID);
    expect(first.start).toBe("wait");
    expect(first.nodes.at(-1)!.next).toBe("check");
  });

  it("a node added after a condition goes on its then branch", () => {
    const draft = draftOf(NOTIFY);
    const node = newNode(draft, spec("wait"));
    const added = addNode(draft, node, spec("wait"), "check");
    expect(added.nodes[0]).toMatchObject({ then: "wait", else: "skip" });
    expect(added.nodes.at(-1)).toMatchObject({ key: "wait", next: "mail" });
  });

  it("a new connector node starts from its schema's defaults and the first credential of its kind", () => {
    const draft = draftOf(NOTIFY);
    expect(newNode(draft, spec("email.send"), DATA.credentials)).toEqual({
      key: "email-send",
      type: "email.send",
      input: { credential: "cred-smtp", to: [""], subject: "", body: "" },
    });
    expect(newNode(draft, spec("github.issue.close"), DATA.credentials)).toMatchObject({
      input: { credential: "cred-gh", repo: "", number: "", reason: "completed" },
    });
    expect(newNode(draft, spec("webhook.send"))).toMatchObject({ input: { url: "", credential: "", body: {} } });
    expect(newNode(draft, spec("condition"))).toMatchObject({ all: [{ field: "", op: "equals", value: "" }] });
    // Keys are free: a second one is numbered.
    const twice = addNode(draft, newNode(draft, spec("end")), spec("end"));
    expect(newNode(twice, spec("end")).key).toBe("end-2");
  });

  it("deleting a node joins the chain around it; deleting the start moves the start on", () => {
    const draft = draftOf(NOTIFY);
    const gone = deleteNode(draft, "mail");
    expect(gone.nodes.map((n) => n.key)).toEqual(["check", "done", "skip"]);
    expect(gone.nodes[0]!.then).toBe("done");
    const startGone = deleteNode(draftOf(ECHO_FLOW), "check");
    // A condition branches: nothing to join, the start is cleared and validation says so.
    expect(startGone.start).toBe("");
    expect(startGone.layout).not.toHaveProperty("check");
  });

  it("renaming a node carries its edges, the start, its layout and what reads it", () => {
    const draft: Draft = {
      ...draftOf(DOCS_FLOW),
      nodes: [
        ...draftOf(DOCS_FLOW)
          .nodes.slice(0, 4)
          .map((n) => (n.key === "create" ? { ...n, next: "tell" } : n)),
        {
          key: "tell",
          type: "email.send",
          input: {
            credential: "c",
            to: ["a@example.com"],
            subject: "{{ steps.draft.output.title }}",
            body: "{{steps.draft.output.body}}",
          },
          next: "end",
        },
        ...draftOf(DOCS_FLOW).nodes.slice(4),
      ],
      layout: { draft: { x: 1, y: 2 } },
    };
    const renamed = renameNode(draft, "draft", "write-up");
    const byKey = Object.fromEntries(renamed.nodes.map((n) => [n.key, n]));
    expect(byKey["only-tagged"]!.then).toBe("write-up");
    expect(byKey.review!.draft).toBe("write-up");
    expect(byKey.tell!.input).toMatchObject({
      subject: "{{ steps.write-up.output.title }}",
      body: "{{steps.write-up.output.body}}",
    });
    expect(renamed.layout).toEqual({ "write-up": { x: 1, y: 2 } });
    expect(renameNode(draft, "draft", "review")).toBe(draft); // taken
    expect(renameNode(draft, "draft", "Not A Key")).toBe(draft);
    const startRenamed = renameNode(draft, "only-tagged", "gate");
    expect(startRenamed.start).toBe("gate");
  });

  it("renaming a key with regex metacharacters rewrites exact reads only, and nothing in the new key is a pattern", () => {
    const odd = "a.(b\\";
    const draft: Draft = {
      version: 2,
      key: "odd",
      trigger: { type: "manual", input: [] },
      start: odd,
      nodes: [
        { key: odd, type: "wait", duration: "PT1M", next: "say" },
        {
          key: "say",
          type: "email.send",
          input: {
            to: ["a@example.com"],
            subject: `{{steps.${odd}.output.x}} and {{ steps.${odd}.output }}`,
            // A "." that matched any character, or a "(" read as a group, would rewrite these.
            body: "{{steps.aX(b\\.output.x}} {{steps.a.(b\\c.output}} {{steps.a.(b.output}}",
          },
          next: "end",
        },
        { key: "end", type: "end" },
      ],
    };
    const renamed = renameNode(draft, odd, "fresh");
    expect(renamed.start).toBe("fresh");
    expect(renamed.nodes[0]!.key).toBe("fresh");
    expect(renamed.nodes[1]!.input).toEqual({
      to: ["a@example.com"],
      subject: "{{steps.fresh.output.x}} and {{ steps.fresh.output }}",
      body: (draft.nodes[1]!.input as { body: string }).body,
    });
    // A "$" can't be in a key (isNodeKey), and the replacement is a function either way.
    expect(renameNode(draft, odd, "$&")).toBe(draft);
  });

  it('connect sets an edge, or with "" removes it; updateNode replaces one node', () => {
    const draft = draftOf(NOTIFY);
    expect(connect(draft, "mail", "next", "skip").nodes[1]!.next).toBe("skip");
    expect(connect(draft, "mail", "next", "").nodes[1]).not.toHaveProperty("next");
    expect(connect(draft, TRIGGER_ID, "start", "mail").start).toBe("mail");
    const changed = updateNode(draft, "done", { key: "done", type: "end", status: "skipped" });
    expect(changed.nodes[2]).toEqual({ key: "done", type: "end", status: "skipped" });
    expect(changed.nodes.filter((_, i) => i !== 2)).toEqual(draft.nodes.filter((_, i) => i !== 2));
  });

  it("a new workflow's first draft is a trigger and an end, and validates", () => {
    const draft = starterDraft("fresh", { type: "manual", input: [] });
    expect(parseDefinition(draft).ok).toBe(true);
  });
});

describe("the catalog", () => {
  it("is the registry's connectors and the v2 node types, grouped for the palette", () => {
    const groups = Object.fromEntries(
      ["Logic", "Email", "GitHub", "Webhooks", "Docs"].map((g) => [
        g,
        catalog.nodes.filter((n) => n.group === g).map((n) => n.type),
      ]),
    );
    expect(groups).toEqual({
      Logic: ["condition", "approval", "wait", "end"],
      Email: ["email.send"],
      GitHub: ["github.comment.create", "github.issue.close", "github.issue.create", "github.labels.add"],
      Webhooks: ["webhook.send"],
      Docs: ["docs.issue-draft", "docs.issue-create"],
    });
    expect(catalog.triggers.map((t) => t.type)).toEqual(["event", "manual", "webhook", "github"]);
  });

  it("marks placeholders, credential kinds and the allow-listed fields from the Zod schemas", () => {
    const email = spec("email.send").settings.properties!;
    expect(email.credential!["x-credential"]).toBe("smtp");
    expect(email.subject!["x-templated"]).toBe(true);
    expect(email.to!.items).toMatchObject({ "x-templated": true, "x-recipient": true });
    const hook = spec("webhook.send").settings.properties!;
    expect(hook.url).toMatchObject({ "x-egress": true });
    expect(hook.url!["x-templated"]).toBeUndefined();
    expect(hook.credential!["x-credential"]).toBe("webhook-secret");
    expect(spec("github.issue.create").settings.properties!.credential!["x-credential"]).toBe("github-token");
    // Built-in nodes' settings leave out key, type and the edges.
    expect(Object.keys(spec("condition").settings.properties!)).toEqual(["all"]);
    expect(spec("condition").edges).toEqual(["then", "else"]);
    expect(spec("end").edges).toEqual([]);
    expect(spec("email.send").output!.properties).toHaveProperty("messageId");
    expect(spec("email.send").output!.properties).not.toHaveProperty("simulated");
  });
});

describe("the checks that need Flow's data", () => {
  it("none for a node that fits", () => {
    expect(dataProblems(NOTIFY, DATA)).toEqual([]);
  });

  it("a missing credential, one that doesn't exist, one of another kind", () => {
    const at = (credential: unknown) =>
      dataProblems(
        { ...NOTIFY, nodes: [{ ...NOTIFY.nodes[1], input: { ...(NOTIFY.nodes[1]!.input as object), credential } }] },
        DATA,
      );
    expect(at("")).toEqual([{ node: "mail", path: "input.credential", message: "choose a smtp credential" }]);
    expect(at(undefined)).toEqual([{ node: "mail", path: "input.credential", message: "choose a smtp credential" }]);
    expect(at("gone")).toEqual([
      { node: "mail", path: "input.credential", message: "the credential doesn't exist (any more): choose another" },
    ]);
    expect(at("cred-gh")).toEqual([
      { node: "mail", path: "input.credential", message: '"GitHub bot" is a github-token credential, not smtp' },
    ]);
  });

  it("a recipient not allowed; a placeholder is left to the run", () => {
    const to = ["ops@example.com", "dev@team.example.com", "eve@evil.example", "{{trigger.email}}"];
    expect(
      dataProblems(
        { ...NOTIFY, nodes: [{ ...NOTIFY.nodes[1], input: { ...(NOTIFY.nodes[1]!.input as object), to } }] },
        DATA,
      ),
    ).toEqual([
      {
        node: "mail",
        path: "input.to.2",
        message: "eve@evil.example isn't an allowed recipient (Settings, email recipients)",
      },
    ]);
  });

  it("a webhook host not on egress_hosts (a port only when the entry names it)", () => {
    const hook = (url: string) =>
      dataProblems(
        { nodes: [{ key: "out", type: "webhook.send", input: { url, credential: "cred-hook", body: {} }, next: "x" }] },
        DATA,
      );
    expect(hook("https://hooks.example.com/in")).toEqual([]);
    expect(hook("https://alt.example.com:8443/in")).toEqual([]);
    expect(hook("https://alt.example.com:9000/in")).toEqual([
      {
        node: "out",
        path: "input.url",
        message: "alt.example.com:9000 isn't on the allowed hosts (Settings, egress hosts)",
      },
    ]);
    expect(hook("https://evil.example/in")).toEqual([
      { node: "out", path: "input.url", message: "evil.example isn't on the allowed hosts (Settings, egress hosts)" },
    ]);
  });

  it("a node without a usable key is named by its index, as validation names it", () => {
    expect(dataProblems({ nodes: [{ type: "email.send", input: { to: ["ops@example.com"] } }] }, DATA)).toEqual([
      { node: "#0", path: "input.credential", message: "choose a smtp credential" },
    ]);
  });
});

describe("problems on their nodes", () => {
  it("validation's problems go to the node they name, the trigger, or the workflow", () => {
    const draft = draftOf({ ...NOTIFY, nodes: [...NOTIFY.nodes, { type: "end" }] });
    const parsed = parseDefinition({ ...draft, start: "nope", trigger: { type: "webhook", input: [{ name: 1 }] } });
    expect(parsed.ok).toBe(false);
    const problems = parsed.ok ? [] : parsed.issues;
    const places = problemsByPlace(draft, problems);
    expect(places.get(TRIGGER_ID)?.map((p) => p.path)).toEqual(
      expect.arrayContaining(["trigger.input.0.name", "start"]),
    );
    expect(places.get("#4")?.length).toBeGreaterThan(0);
    // Every problem is placed once.
    expect([...places.values()].flat()).toHaveLength(problems.length);
  });

  it("placeOf: a key, an index, a trigger path, a nodes[i] path, anything else", () => {
    const draft = draftOf(NOTIFY);
    expect(placeOf(draft, { node: "mail", path: "input.to.0", message: "" })).toBe("mail");
    expect(placeOf(draft, { node: "#3", path: "", message: "" })).toBe("skip");
    expect(placeOf(draft, { path: "trigger.input", message: "" })).toBe(TRIGGER_ID);
    expect(placeOf(draft, { path: "start", message: "" })).toBe(TRIGGER_ID);
    expect(placeOf(draft, { path: "nodes.1.key", message: "" })).toBe("mail");
    expect(placeOf(draft, { path: "nodes", message: "" })).toBe(WORKFLOW);
    expect(placeOf(draft, { node: "ghost", path: "", message: "" })).toBe(WORKFLOW);
  });
});

describe("placeholder suggestions", () => {
  /** trigger → a → fork(then: b, else: c) → d → e; b and c both go to d. */
  const FORK: Draft = {
    version: 2,
    key: "fork",
    trigger: { type: "manual", input: [{ name: "who", type: "string" }] },
    start: "a",
    nodes: [
      { key: "a", type: "email.send", input: {}, next: "fork" },
      { key: "fork", type: "condition", all: [], then: "b", else: "c" },
      { key: "b", type: "github.issue.create", input: {}, next: "d" },
      { key: "c", type: "webhook.send", input: {}, next: "d" },
      { key: "d", type: "github.labels.add", input: {}, next: "e" },
      { key: "e", type: "end" },
    ],
  };
  const stepsOf = (key: string) => [...new Set(suggestionsFor(FORK, key, catalog).map((s) => s.path.split(".")[1]))];

  it("only from steps upstream on every path, never the node itself, a later one or another branch", () => {
    expect(stepsOf("a")).toEqual(["who"]); // only the trigger
    expect(stepsOf("b")).toEqual(["who", "a"]);
    expect(stepsOf("c")).toEqual(["who", "a"]);
    // d is reached through b or c: neither is upstream on every path.
    expect(stepsOf("d")).toEqual(["who", "a"]);
    expect(stepsOf("e")).toEqual(["who", "a", "d"]);
  });

  it("the paths are the trigger's example and the connector output schemas", () => {
    const paths = suggestionsFor(FORK, "e", catalog).map((s) => s.path);
    expect(paths).toEqual([
      "trigger.who",
      "steps.a.output",
      "steps.a.output.messageId",
      "steps.d.output",
      "steps.d.output.labels",
    ]);
  });

  it("agree with validation's rule of what a node may read", () => {
    const up = upstreamOf(FORK);
    expect([...up.get("d")!]).toEqual(["a", "fork"]);
    expect(up.get("e")).toEqual(new Set(["a", "fork", "d"]));
  });

  it("a cycle or a node not reached from the start gets the trigger's fields only", () => {
    const cyclic = { ...FORK, nodes: FORK.nodes.map((n) => (n.key === "d" ? { ...n, next: "a" } : n)) };
    expect([...new Set(suggestionsFor(cyclic, "d", catalog).map((s) => s.path.split(".")[0]))]).toEqual(["trigger"]);
    expect(suggestionsFor({ ...FORK, start: "b" }, "a", catalog).every((s) => s.from === "trigger")).toBe(true);
  });

  it("the trigger's example: its input fields, a GitHub delivery's, and what the draft reads", () => {
    expect(triggerExample(draftOf(ECHO_FLOW))).toEqual({ name: "example name", loud: true });
    expect(
      triggerExample({
        ...draftOf(DOCS_FLOW),
        trigger: { type: "github", repos: ["acme/app"], events: ["issues.opened"] },
      }),
    ).toMatchObject({ repository: { full_name: "acme/app" }, issue: { number: 1 }, tags: "" });
  });
});

describe("version 1 as version 2", () => {
  it("the shipped workflow converts to a v2 draft that validates and runs the same steps", () => {
    const draft = v1ToV2(DOCS_NOTE_TO_ISSUE.definition);
    const parsed = parseDefinition(draft);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
    expect(draft.start).toBe("only-tagged");
    expect(draft.nodes.map((n) => [n.key, n.type])).toEqual([
      ["only-tagged", "condition"],
      ["draft", "docs.issue-draft"],
      ["review", "approval"],
      ["create", "docs.issue-create"],
      ["end", "end"],
      ["skipped", "end"],
    ]);
    expect(draft.nodes[2]).toMatchObject({ draft: "draft", next: "create" });
    expect(draft.nodes[3]).toMatchObject({ approval: "review", next: "end" });
  });

  it("openWorkflow: the draft first, then the published version, then a starter", () => {
    const version = {
      id: "v",
      workflowId: "w",
      version: 1,
      publishedAt: new Date(),
      definition: DOCS_NOTE_TO_ISSUE.definition,
    };
    expect(openWorkflow({ key: "docs-note-to-issue", draft: null, current: version }).from).toBe("v1");
    expect(openWorkflow({ key: "echo-flow", draft: clone(ECHO_FLOW), current: version })).toMatchObject({
      from: "draft",
      draft: { start: "check" },
    });
    expect(openWorkflow({ key: "fresh", draft: null, current: null })).toMatchObject({
      from: "new",
      draft: { key: "fresh" },
    });
  });
});

describe("the versions diff", () => {
  it("compares the definitions with their keys sorted, line by line", () => {
    expect(sortedJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe(
      JSON.stringify({ a: { c: [{ e: 2, f: 1 }], d: 2 }, b: 1 }, null, 2),
    );
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    const v1 = sortedJson(ECHO_FLOW);
    expect(lineDiff(v1, v1).every((l) => l.kind === "same")).toBe(true);
  });
});

describe("publish is refused while the builder's checks find a problem", () => {
  it("a missing credential and a recipient not allowed refuse it; fixed, it publishes", async () => {
    const mem = memoryDb();
    const engine = createEngine({
      store: () => mem.store,
      publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
      newId: () => ulid(),
      log: { info: () => undefined, warn: () => undefined },
      manifest,
    });
    const bad = clone(NOTIFY) as unknown as Draft;
    (bad.nodes[1]!.input as Record<string, unknown>).credential = "";
    (bad.nodes[1]!.input as Record<string, unknown>).to = ["eve@evil.example"];
    const saved = await engine.saveDraft(mem.tx, {
      workflowKey: "notify",
      name: "Notify",
      definition: bad,
      actor: "a",
      expect: "new",
    });
    // The definition's own checks pass but for the credential: the schema wants one.
    expect(saved.ok && saved.problems.map((p) => p.path)).toEqual(["input.credential"]);
    const refused = await engine.publishDraft(mem.tx, {
      workflowKey: "notify",
      actor: "a",
      check: async (d) => dataProblems(d, DATA),
    });
    expect(refused).toMatchObject({ ok: false, error: "invalid_definition" });
    expect(refused.ok ? [] : refused.problems!.map((p) => `${p.node} ${p.path}`)).toEqual([
      "mail input.credential",
      "mail input.credential",
      "mail input.to.0",
    ]);
    expect(mem.versions).toEqual([]);

    await engine.saveDraft(mem.tx, { workflowKey: "notify", definition: clone(NOTIFY), actor: "a" });
    expect(
      await engine.publishDraft(mem.tx, {
        workflowKey: "notify",
        actor: "a",
        check: async (d) => dataProblems(d, DATA),
      }),
    ).toMatchObject({ ok: true, version: 1 });
  });
});

describe("node ids", () => {
  it("are the keys, or #index for a missing or shared key", () => {
    expect(nodeIds(draftOf({ ...NOTIFY, nodes: [{ key: "a" }, { key: "b" }, { key: "b" }, {}] }))).toEqual([
      "a",
      "#1",
      "#2",
      "#3",
    ]);
  });
});
