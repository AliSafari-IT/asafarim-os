/**
 * The builder's catalog (server only): every node type the palette offers and the trigger types, with
 * their settings as JSON Schema made from their Zod schemas. Connectors come from the registry
 * (lib/engine/connectors.ts), built-in nodes and triggers from definition v2, so a connector registered
 * later shows up in the palette and gets a settings form without a change here.
 */
import { z } from "zod";
import { connectors as registry, type ConnectorRegistry } from "../engine/connectors";
import { Draft as IssueDraft } from "../workflow/approval";
import { BUILTIN_NODES, BUILTIN_TYPES, TriggerV2, type BuiltinType } from "../workflow/definition-v2";
import { fieldMark } from "../workflow/fields";
import { isTemplated } from "../workflow/templates";
import type { Catalog, EdgeField, JsonSchema, NodeSpec, TriggerSpec } from "./types";

/** The palette group of a node type, by the app its type starts with; anything else is Logic. */
const GROUPS: Record<string, string> = { email: "Email", github: "GitHub", webhook: "Webhooks", docs: "Docs" };

const groupOf = (type: string) => GROUPS[type.split(".")[0]!] ?? "Logic";

const BUILTIN_LABELS: Partial<Record<BuiltinType, string>> = {
  condition: "Condition",
  approval: "Approval",
  wait: "Wait",
  end: "End",
  "docs.issue-draft": "Draft an issue (Docs)",
  "docs.issue-create": "Create the issue (Docs)",
};
const TRIGGER_LABELS: Record<string, string> = {
  event: "An OS app event",
  manual: "Run by hand",
  webhook: "A webhook",
  github: "A GitHub event",
};

/** `github.issue.create` → "GitHub: issue create". */
function connectorLabel(type: string): string {
  const [app, ...rest] = type.split(".");
  const name = GROUPS[app!]?.replace(/s$/, "") ?? app!;
  return `${name}: ${rest.join(" ").replace(/-/g, " ")}`;
}

/** Zod to JSON Schema, with the placeholder and field marks as `x-*` keys. */
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override(ctx) {
      const s = ctx.zodSchema as unknown as z.ZodType;
      const js = ctx.jsonSchema as JsonSchema;
      if (isTemplated(s)) js["x-templated"] = true;
      const mark = fieldMark(s);
      if (mark && "credential" in mark) js["x-credential"] = mark.credential;
      if (mark && "egress" in mark) js["x-egress"] = true;
      if (mark && "recipient" in mark) js["x-recipient"] = true;
    },
  }) as JsonSchema;
}

/** `schema` (an object) without some of its properties. */
function without(schema: JsonSchema, keys: readonly string[]): JsonSchema {
  const { $schema: _drop, ...rest } = schema as JsonSchema & { $schema?: string };
  return {
    ...rest,
    properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !keys.includes(k))),
    required: (schema.required ?? []).filter((k) => !keys.includes(k)),
  };
}

const NODE_FIELDS = ["key", "type", "next", "then", "else"];

/** What the built-in nodes' steps output: a draft, an approver's decision, an issue's link. */
const BUILTIN_OUTPUTS: Partial<Record<BuiltinType, JsonSchema>> = {
  "docs.issue-draft": jsonSchemaOf(IssueDraft),
  approval: jsonSchemaOf(
    z.object({
      title: z.string(),
      body: z.string(),
      labels: z.array(z.string()),
      repo: z.string(),
      decidedBy: z.string(),
      decidedAt: z.string(),
    }),
  ),
  "docs.issue-create": jsonSchemaOf(z.object({ noteId: z.string(), issueUrl: z.string() })),
};

function builtinSpec(type: BuiltinType): NodeSpec {
  const schema = jsonSchemaOf(BUILTIN_NODES[type]);
  const edges: EdgeField[] = type === "end" ? [] : type === "condition" ? ["then", "else"] : ["next"];
  return {
    type,
    group: groupOf(type),
    label: BUILTIN_LABELS[type] ?? type,
    connector: false,
    edges,
    settings: without(schema, NODE_FIELDS),
    ...(BUILTIN_OUTPUTS[type] ? { output: BUILTIN_OUTPUTS[type] } : {}),
  };
}

export function buildCatalog(connectors: ConnectorRegistry = registry): Catalog {
  const triggers: TriggerSpec[] = TriggerV2.options.map((option) => {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    return { type, label: TRIGGER_LABELS[type] ?? type, settings: without(jsonSchemaOf(option), ["type"]) };
  });
  const nodes: NodeSpec[] = [
    ...BUILTIN_TYPES.map(builtinSpec),
    ...connectors.types().map((type): NodeSpec => {
      const c = connectors.get(type)!;
      return {
        type,
        group: groupOf(type),
        label: connectorLabel(type),
        connector: true,
        edges: ["next"],
        settings: without(jsonSchemaOf(c.input), []),
        output: without(jsonSchemaOf(c.output), ["simulated"]),
      };
    }),
  ];
  return { triggers, nodes };
}
