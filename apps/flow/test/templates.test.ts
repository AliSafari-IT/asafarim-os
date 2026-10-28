/**
 * Placeholders: replaced as plain text, once (a value holding `{{…}}` is never evaluated: no
 * injection), any non-string value as its JSON, a missing or null value refused; only a templated field
 * of a connector's input is filled.
 */
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../lib/workflow/context";
import { MissingValueError, placeholdersIn, render, renderInput, templatedText } from "../lib/workflow/templates";

const ctx: RunContext = {
  runId: "r1",
  trigger: {
    name: "Ada",
    count: 3,
    ok: false,
    tags: ["a", "b"],
    evil: "{{trigger.secret}}",
    secret: "s3cr3t",
    none: null,
  },
  steps: { fetch: { output: { title: "T {{steps.fetch.output.title}}", nested: { n: 1 } } } },
};

describe("render", () => {
  it("replaces each placeholder by its value: text as is, anything else as JSON", () => {
    expect(render("Hi {{trigger.name}}, {{ trigger.count }} {{trigger.ok}} {{trigger.tags}}", ctx)).toBe(
      'Hi Ada, 3 false ["a","b"]',
    );
    expect(render("{{steps.fetch.output.nested}} / {{steps.fetch.output.nested.n}}", ctx)).toBe('{"n":1} / 1');
  });

  it("once: a value that holds a placeholder stays as text (no injection)", () => {
    expect(render("x {{trigger.evil}} y", ctx)).toBe("x {{trigger.secret}} y");
    expect(render("{{steps.fetch.output.title}}", ctx)).toBe("T {{steps.fetch.output.title}}");
  });

  it("a missing or null value: MissingValueError, naming the path", () => {
    expect(() => render("{{trigger.nope}}", ctx)).toThrow(MissingValueError);
    expect(() => render("{{trigger.none}}", ctx)).toThrow("{{trigger.none}} has no value in this run");
    expect(() => render("{{steps.other.output.x}}", ctx)).toThrow(MissingValueError);
  });

  it("text without placeholders is left alone", () => {
    expect(render("plain } { text", ctx)).toBe("plain } { text");
  });
});

describe("placeholdersIn", () => {
  it("the paths read, and what is malformed", () => {
    expect(placeholdersIn("{{trigger.a.b}} {{ steps.x.output }}")).toEqual({
      paths: ["trigger.a.b", "steps.x.output"],
      problems: [],
    });
    expect(placeholdersIn("{{process.env.X}} {{trigger}} {{trigger.a")).toEqual({
      paths: [],
      problems: [
        "{{process.env.X}} isn't {{trigger.<field>}} or {{steps.<key>.output.<field>}}",
        "{{trigger}} isn't {{trigger.<field>}} or {{steps.<key>.output.<field>}}",
        "has a {{ that doesn't close a placeholder",
      ],
    });
  });
});

describe("renderInput", () => {
  const Input = z.strictObject({
    subject: templatedText(),
    to: z.array(templatedText()).optional(),
    raw: z.string(),
    nested: z.strictObject({ body: templatedText().optional() }).optional(),
  });

  it("fills only the templated fields (in arrays and nested objects too), and leaves the input as it was", () => {
    const input = {
      subject: "For {{trigger.name}}",
      to: ["{{trigger.name}}@example.org"],
      raw: "{{trigger.name}}",
      nested: { body: "{{trigger.count}} items" },
    };
    expect(renderInput(Input, input, ctx)).toEqual({
      subject: "For Ada",
      to: ["Ada@example.org"],
      raw: "{{trigger.name}}",
      nested: { body: "3 items" },
    });
    expect(input.subject).toBe("For {{trigger.name}}");
  });

  it("a refinement after templatedText() isn't templated any more", () => {
    const Refined = z.strictObject({ s: templatedText().min(1) });
    expect(renderInput(Refined, { s: "{{trigger.name}}" }, ctx)).toEqual({ s: "{{trigger.name}}" });
  });
});
