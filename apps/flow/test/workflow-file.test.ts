import { describe, expect, it } from "vitest";
import { buildCatalog } from "../lib/builder/catalog";
import {
  exportWorkflowFile,
  IMPORT_PLACEHOLDER_CREDENTIAL,
  IMPORT_PLACEHOLDER_HOOK,
  WORKFLOW_FILE_FORMAT,
  WORKFLOW_FILE_MAX_BYTES,
} from "../lib/builder/file";
import { parseWorkflowFile } from "../lib/builder/file-import";
import type { Draft } from "../lib/builder/types";
import { workflowDiagram, workflowOutline } from "../lib/builder/visual";

const catalog = buildCatalog();
const draft = (): Draft => ({
  version: 2,
  key: "portable-flow",
  trigger: { type: "manual", input: [] },
  start: "wait",
  nodes: [
    { key: "wait", type: "wait", duration: "PT1M", next: "done" },
    { key: "done", type: "end" },
  ],
  layout: { wait: { x: 120, y: 80 }, done: { x: 360, y: 80 } },
});
const envelope = (definition: unknown) => ({
  format: WORKFLOW_FILE_FORMAT,
  version: 1,
  exportedAt: "2026-10-30T00:00:00.000Z",
  definition,
});

describe("workflow files", () => {
  it("round trips a v2 definition and its layout", () => {
    const original = draft();
    const file = exportWorkflowFile(original, catalog, "2026-10-30T00:00:00.000Z");
    const parsed = parseWorkflowFile(file);
    expect(parsed).toEqual({ ok: true, definition: original });
  });

  it("exports placeholders instead of credentials, webhook ids, recipients, egress values, and secret fields", () => {
    const original = draft();
    original.trigger = { type: "webhook", hook: "h".repeat(22), input: [] };
    original.nodes[1] = {
      key: "shout",
      type: "email.send",
      input: {
        credential: "credential-secret-id",
        to: ["private.person@example.com"],
        subject: "Private subject",
        body: "Private body",
        accessToken: "secret-token-value",
      },
      next: "done",
    };
    original.nodes.push({ key: "done", type: "end" });
    original.nodes[0]!.next = "shout";
    const json = JSON.stringify(exportWorkflowFile(original, catalog));
    expect(json).not.toContain("credential-secret-id");
    expect(json).not.toContain("h".repeat(22));
    expect(json).not.toContain("private.person@example.com");
    expect(json).not.toContain("secret-token-value");
    expect(json).toContain(`"credential":"${IMPORT_PLACEHOLDER_CREDENTIAL}"`);
    expect(json).toContain(IMPORT_PLACEHOLDER_HOOK);
    expect(json).toContain("recipient@example.invalid");
    expect(json).not.toContain("accessToken");

    const imported = parseWorkflowFile(JSON.parse(json));
    expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true });
    if (imported.ok) {
      expect(imported.definition.trigger).toMatchObject({ hook: "" });
      expect(imported.definition.nodes[1]?.input).toMatchObject({ credential: "" });
    }
  });

  it("rejects unknown formats and versions", () => {
    const file = envelope(draft());
    expect(parseWorkflowFile({ ...file, format: "other" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("format"),
    });
    expect(parseWorkflowFile({ ...file, version: 99 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("version"),
    });
  });

  it("rejects oversized files before parsing definitions", () => {
    const file = { ...envelope(draft()), extra: "x".repeat(WORKFLOW_FILE_MAX_BYTES) };
    expect(parseWorkflowFile(file)).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
  });

  it("refuses secret-looking fields without echoing their values", () => {
    const definition = draft();
    definition.nodes[0]!.apiToken = "must-not-be-returned";
    const result = parseWorkflowFile(envelope(definition));
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret fields"),
      problems: [expect.stringContaining("apiToken")],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
  });

  it("refuses a cyclic graph and reports the validation problems", () => {
    const definition = draft();
    definition.start = "check";
    definition.nodes = [
      {
        key: "check",
        type: "condition",
        all: [{ field: "trigger.flag", op: "equals", value: true }],
        then: "check",
        else: "done",
      },
      { key: "done", type: "end" },
    ];
    const result = parseWorkflowFile(envelope(definition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid");
      expect(result.problems?.length).toBeGreaterThan(0);
    }
  });

  it("refuses workflows with more than 50 nodes", () => {
    const definition = draft();
    definition.nodes = Array.from({ length: 51 }, (_, index) => ({
      key: `node-${index}`,
      type: "end",
    }));
    expect(parseWorkflowFile(envelope(definition))).toMatchObject({
      ok: false,
      error: expect.stringContaining("maximum is 50"),
    });
  });

  it("converts valid version 1 definitions to version 2 on import", () => {
    const result = parseWorkflowFile(
      envelope({
        key: "legacy-flow",
        trigger: { event: "docs.note.created.v1" },
        steps: [{ key: "done", type: "end" }],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      definition: {
        version: 2,
        key: "legacy-flow",
        trigger: { type: "event", event: "docs.note.created.v1" },
      },
    });
  });

  it("builds a branch-aware outline and settings-free diagram", () => {
    const definition = draft();
    definition.start = "check";
    definition.nodes = [
      {
        key: "check",
        type: "condition",
        all: [{ field: "trigger.flag", op: "equals", value: true }],
        then: "yes",
        else: "no",
      },
      { key: "yes", type: "end" },
      { key: "no", type: "end", status: "skipped" },
    ];
    const outline = workflowOutline(definition).join("\n");
    expect(outline).toContain("Then → 2. yes");
    expect(outline).toContain("Else → 3. no");
    expect(outline).not.toContain("trigger.flag");
    const diagram = workflowDiagram(definition);
    expect(diagram.nodes.map(({ id }) => id)).toEqual(["@trigger", "check", "yes", "no"]);
    expect(diagram.edges).toHaveLength(3);
    expect(JSON.stringify(diagram)).not.toContain("trigger.flag");
  });
});
