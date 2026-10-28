/**
 * Definition v2's validator, one rule at a time: the graph (acyclic, reachable, every path ends at an
 * end, at most 50 nodes, unique kebab-case keys), each node type, the triggers, connector inputs and
 * where placeholders may go and what they may read (upstream on every path); every problem at once,
 * each with its node's key. And v1 still parses.
 */
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { createConnectorRegistry } from "../lib/engine/connectors";
import { manifestProblems, parseDefinition, type Problem } from "../lib/workflow/definition";
import { inputProblems, validateV2 } from "../lib/workflow/definition-v2";
import { DOCS_NOTE_TO_ISSUE } from "../lib/workflow/seed";
import { ECHO, registerEcho } from "./echo-connector";
import { clone, DOCS_FLOW, ECHO_FLOW } from "./v2-fixtures";

beforeAll(registerEcho);

const problems = (value: unknown): Problem[] => {
  const r = validateV2(value);
  return r.ok ? [] : r.problems;
};
/** A definition to change freely in a test. */
type Def = Record<string, unknown> & { nodes: Record<string, unknown>[] };
const echo = (change: (d: Def) => void) => {
  const d = clone(ECHO_FLOW) as unknown as Def;
  change(d);
  return d;
};
const node = (d: { nodes: readonly Record<string, unknown>[] }, key: string) => d.nodes.find((n) => n.key === key)!;

describe("a valid v2 definition", () => {
  it("parses, with the defaults filled in and the layout kept", () => {
    const r = parseDefinition(ECHO_FLOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition).toMatchObject({ version: 2, key: "echo-flow", start: "check", layout: ECHO_FLOW.layout });
    expect(r.definition).toMatchObject({
      trigger: {
        input: [
          { name: "name", required: true },
          { name: "loud", required: false },
        ],
      },
      nodes: [
        { key: "check" },
        { key: "shout", input: { text: "Hello {{trigger.name}}!" } },
        { key: "done", status: "succeeded" },
      ],
    });
  });

  it("the Docs graph is valid, and fits the manifest", () => {
    const r = parseDefinition(DOCS_FLOW);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(manifestProblems(r.definition, manifest)).toEqual([]);
    expect(problems(DOCS_FLOW)).toEqual([]);
  });

  it("v1 stays valid next to it: the shipped workflow parses as before", () => {
    expect(parseDefinition(DOCS_NOTE_TO_ISSUE.definition)).toEqual({
      ok: true,
      definition: DOCS_NOTE_TO_ISSUE.definition,
    });
  });
});

describe("the graph", () => {
  it("must not have a cycle: the edge back is reported on the node it leaves", () => {
    const d = echo((d) => (node(d, "shout").next = "check"));
    expect(problems(d)).toContainEqual({
      node: "shout",
      path: "next",
      message: 'goes back to "check": the graph must not have a cycle',
    });
  });

  it("every node is reachable from start", () => {
    const d = echo((d) => d.nodes.push({ key: "orphan", type: "end" }));
    expect(problems(d)).toEqual([{ node: "orphan", path: "", message: 'isn\'t reachable from "check"' }]);
  });

  it("start is a node", () => {
    expect(problems(echo((d) => ((d as Record<string, unknown>).start = "nope")))).toContainEqual({
      path: "start",
      message: '"nope" isn\'t a node',
    });
  });

  it("every path ends at an end: an edge to nowhere, a node with no next", () => {
    const toNowhere = echo((d) => (node(d, "shout").next = "missing"));
    expect(problems(toNowhere)).toContainEqual({
      node: "shout",
      path: "next",
      message: 'goes to "missing", which isn\'t a node',
    });
    const noNext = echo((d) => delete node(d, "shout").next);
    expect(problems(noNext)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: "shout", path: "next" }),
        { node: "shout", path: "", message: "a path ends here: only an end node may have no next node" },
      ]),
    );
  });

  it("an end has no next", () => {
    expect(problems(echo((d) => (node(d, "done").next = "check")))).toContainEqual(
      expect.objectContaining({ node: "done", message: expect.stringMatching(/Unrecognized key/) }),
    );
  });

  it("at most 50 nodes", () => {
    const d = echo((d) => {
      node(d, "shout").next = "w0";
      for (let i = 0; i < 50; i++)
        d.nodes.push({ key: `w${i}`, type: "wait", duration: "PT1M", next: i < 49 ? `w${i + 1}` : "done" });
    });
    expect(problems(d)).toEqual([{ path: "nodes", message: "has 53 nodes, at most 50" }]);
  });

  it("keys are unique and kebab-case", () => {
    const d = echo((d) => {
      d.nodes.push({ key: "done", type: "end" });
      node(d, "shout").key = "Shout_It";
    });
    const found = problems(d);
    expect(found).toContainEqual({ node: "done", path: "key", message: "duplicate node key" });
    expect(found).toContainEqual({ node: "#1", path: "key", message: "must be kebab-case" });
  });

  it("returns every problem at once, each with its node's key", () => {
    const d = echo((d) => {
      node(d, "check").then = "nowhere";
      node(d, "shout").input = { text: 7 };
      d.nodes.push({ key: "late", type: "wait", duration: "P31D", next: "done" });
    });
    const nodes = problems(d).map((p) => p.node);
    expect(nodes).toEqual(expect.arrayContaining(["check", "shout", "late"]));
  });
});

describe("node types", () => {
  it("an unknown type, an unregistered connector, a connector type that is a built-in", () => {
    expect(problems(echo((d) => (node(d, "shout").type = "Nope")))).toContainEqual({
      node: "shout",
      path: "type",
      message: "must be a node type",
    });
    expect(problems(echo((d) => (node(d, "shout").type = "a.b.c.d.e")))).toContainEqual({
      node: "shout",
      path: "type",
      message: "must be a node type",
    });
    expect(problems(echo((d) => (node(d, "shout").type = "sms.send")))).toContainEqual({
      node: "shout",
      path: "type",
      message: "no connector sms.send",
    });
  });

  it("a connector's input is checked against its schema", () => {
    expect(problems(echo((d) => (node(d, "shout").input = { text: "x", extra: 1 })))).toContainEqual(
      expect.objectContaining({ node: "shout", path: "input" }),
    );
    expect(problems(echo((d) => (node(d, "shout").input = { text: 5 })))).toContainEqual(
      expect.objectContaining({ node: "shout", path: "input.text" }),
    );
  });

  it("with `connectors: false` (a stored version) any connector type is read, its input unchecked", () => {
    const d = echo((d) => (node(d, "shout").type = "gone.away"));
    expect(validateV2(d, { connectors: false }).ok).toBe(true);
    expect(validateV2(d, { connectors: createConnectorRegistry() }).ok).toBe(false);
  });

  it("condition: then and else are nodes, its clauses as v1's", () => {
    expect(problems(echo((d) => delete node(d, "check").else))).toContainEqual(
      expect.objectContaining({ node: "check", path: "else" }),
    );
    expect(problems(echo((d) => (node(d, "check").all = [{ field: "nope", op: "equals", value: 1 }])))).toContainEqual(
      expect.objectContaining({ node: "check", path: "all.0.field" }),
    );
  });

  it("wait: an ISO 8601 duration of at most 30 days", () => {
    const wait = (duration: string) =>
      echo((d) => {
        node(d, "shout").next = "pause";
        d.nodes.push({ key: "pause", type: "wait", duration, next: "done" });
      });
    expect(problems(wait("P30D"))).toEqual([]);
    expect(problems(wait("P30DT1S"))).toEqual([
      { node: "pause", path: "duration", message: "must be at most 30 days" },
    ]);
    expect(problems(wait("1 hour"))).toContainEqual(expect.objectContaining({ node: "pause", path: "duration" }));
  });

  it("approval: editable needs a draft; the draft is a docs.issue-draft node", () => {
    const d = clone(DOCS_FLOW) as unknown as { nodes: Record<string, unknown>[] };
    delete node(d, "review").draft;
    expect(problems(d)).toEqual(
      expect.arrayContaining([
        { node: "review", path: "editable", message: "needs a draft to edit" },
        { node: "create", path: "approval", message: '"review" doesn\'t review a draft' },
      ]),
    );
    const wrong = clone(DOCS_FLOW) as unknown as { nodes: Record<string, unknown>[] };
    node(wrong, "review").draft = "only-tagged";
    expect(problems(wrong)).toContainEqual({
      node: "review",
      path: "draft",
      message: '"only-tagged" must be a node of type docs.issue-draft',
    });
  });

  it("docs.issue-create: its approval is an approval node upstream", () => {
    const d = clone(DOCS_FLOW) as unknown as { nodes: Record<string, unknown>[] };
    node(d, "create").approval = "draft";
    expect(problems(d)).toContainEqual({
      node: "create",
      path: "approval",
      message: '"draft" must be a node of type approval',
    });
  });

  it("end: succeeded or skipped", () => {
    expect(problems(echo((d) => (node(d, "done").status = "failed")))).toContainEqual(
      expect.objectContaining({ node: "done", path: "status" }),
    );
  });
});

describe("triggers", () => {
  it("event: an event type", () => {
    expect(problems({ ...clone(DOCS_FLOW), trigger: { type: "event", event: "nope" } })).toContainEqual(
      expect.objectContaining({ path: "trigger.event" }),
    );
  });

  it("manual: distinct field names of string, number or boolean", () => {
    const typed = { ...clone(ECHO_FLOW), trigger: { type: "manual", input: [{ name: "a", type: "date" }] } };
    expect(problems(typed).map((p) => p.path)).toContain("trigger.input.0.type");
    const twice = {
      ...clone(ECHO_FLOW),
      trigger: {
        type: "manual",
        input: [
          { name: "a", type: "string" },
          { name: "a", type: "number" },
        ],
      },
    };
    expect(problems(twice)).toContainEqual({ path: "trigger.input", message: "field names must be distinct" });
  });

  it("webhook and github: their schemas (their entry points come with PR 2.4)", () => {
    const base = { ...clone(ECHO_FLOW), nodes: [{ key: "done", type: "end" }], start: "done" };
    expect(
      problems({ ...base, trigger: { type: "webhook", input: [{ name: "id", type: "number", required: true }] } }),
    ).toEqual([]);
    expect(
      problems({
        ...base,
        trigger: { type: "github", repo: "AliSafari-IT/asafarim-os", events: ["issues.opened", "push"] },
      }),
    ).toEqual([]);
    expect(problems({ ...base, trigger: { type: "github", repo: "nope", events: [] } }).map((p) => p.path)).toEqual(
      expect.arrayContaining(["trigger.repo", "trigger.events"]),
    );
  });

  it("the data of a run against the input fields", () => {
    const fields = ECHO_FLOW.trigger.input.map((f) => ({ required: false, ...f }));
    expect(inputProblems(fields, { name: "Ada", loud: true })).toEqual([]);
    expect(inputProblems(fields, { name: "" })).toEqual(["name: is required"]);
    expect(inputProblems(fields, { name: 3, loud: "yes", extra: 1 })).toEqual([
      "extra: isn't an input field",
      "name: must be a string",
      "loud: must be a boolean",
    ]);
  });

  it("a v2 event trigger must be in the manifest's subscribes", () => {
    const r = parseDefinition({ ...clone(DOCS_FLOW), trigger: { type: "event", event: "docs.note.deleted.v1" } });
    expect(r.ok && manifestProblems(r.definition, manifest)).toEqual([
      "the trigger docs.note.deleted.v1 isn't in events.subscribes",
    ]);
  });
});

describe("placeholders", () => {
  it("only in a templated field: not in a non-templated connector field, nor in a built-in node", () => {
    expect(problems(echo((d) => (node(d, "shout").input = { text: "ok", note: "{{trigger.name}}" })))).toEqual([
      { node: "shout", path: "input.note", message: "doesn't take placeholders" },
    ]);
    expect(
      problems(echo((d) => ((node(d, "check").all as { value: unknown }[])[0]!.value = "{{trigger.name}}"))),
    ).toEqual([{ node: "check", path: "all.0.value", message: "doesn't take placeholders" }]);
  });

  it("well formed: trigger.<field> or steps.<key>.output…, closed", () => {
    const found = problems(echo((d) => (node(d, "shout").input = { text: "{{ env.SECRET }} and {{trigger.name" })));
    expect(found).toEqual([
      {
        node: "shout",
        path: "input.text",
        message: "{{ env.SECRET }} isn't {{trigger.<field>}} or {{steps.<key>.output.<field>}}",
      },
      { node: "shout", path: "input.text", message: "has a {{ that doesn't close a placeholder" },
    ]);
  });

  it("a trigger field the manual trigger has", () => {
    expect(problems(echo((d) => (node(d, "shout").input = { text: "{{trigger.age}}" })))).toEqual([
      { node: "shout", path: "input.text", message: "reads trigger.age, which the trigger's input doesn't have" },
    ]);
  });

  /** check → (then) a → c, (else) b → c: c may read check, not a nor b. */
  const diamond = (reads: string) =>
    echo((d) => {
      d.nodes = [
        {
          key: "check",
          type: "condition",
          all: [{ field: "trigger.loud", op: "equals", value: true }],
          then: "a",
          else: "b",
        },
        { key: "a", type: "test.echo", input: { text: "a" }, next: "c" },
        { key: "b", type: "test.echo", input: { text: "b" }, next: "c" },
        { key: "c", type: "test.echo", input: { text: reads }, next: "done" },
        { key: "done", type: "end" },
      ];
    });

  it("a node upstream on EVERY path, not on one of them only", () => {
    expect(problems(diamond("{{steps.check.output.passed}}"))).toEqual([]);
    expect(problems(diamond("{{steps.a.output.text}}"))).toEqual([
      { node: "c", path: "input.text", message: 'reads "a", which isn\'t upstream of this node on every path' },
    ]);
  });

  it("not a node downstream, nor itself, nor one that doesn't exist", () => {
    expect(problems(diamond("{{steps.c.output.text}}"))).toEqual([
      { node: "c", path: "input.text", message: 'reads "c", which isn\'t upstream of this node on every path' },
    ]);
    expect(problems(diamond("{{steps.zzz.output}}"))).toEqual([
      { node: "c", path: "input.text", message: 'reads "zzz", which isn\'t a node' },
    ]);
  });

  it("a condition's field follows the same rule", () => {
    const d = diamond("x");
    d.nodes[3] = {
      key: "c",
      type: "condition",
      all: [{ field: "steps.b.output.text", op: "equals", value: "b" }],
      then: "done",
      else: "done",
    };
    expect(problems(d)).toEqual([
      { node: "c", path: "all.0.field", message: 'reads "b", which isn\'t upstream of this node on every path' },
    ]);
  });
});

it("the echo connector is only in the tests' registry", () => {
  expect(ECHO.type).toBe("test.echo");
});
