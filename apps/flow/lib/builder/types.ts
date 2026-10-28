/**
 * What the builder works with, on the server and in the browser. The builder edits the draft
 * definition itself (`Draft`: the v2 JSON as saved, valid or not); there is no second model of it. The
 * catalog describes the node types for the palette and the settings forms: JSON Schema made from each
 * node's Zod schema on the server (lib/builder/catalog.ts), since the Zod schemas and the connector
 * registry stay there.
 */
import type { CredentialKind } from "../credentials/store";
import type { Problem } from "../workflow/schema";

export type { Problem };

/** A JSON Schema, the part of it the settings forms read. `x-*`: the marks of lib/workflow/fields.ts. */
export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  /** Takes `{{…}}` placeholders. */
  "x-templated"?: true;
  /** Holds the id of a credential of this kind. */
  "x-credential"?: CredentialKind;
  /** A URL checked against Settings `egress_hosts`. */
  "x-egress"?: true;
  /** An address checked against Settings `email_recipients`. */
  "x-recipient"?: true;
}

export const EDGE_FIELDS = ["next", "then", "else"] as const;
export type EdgeField = (typeof EDGE_FIELDS)[number];

/** A node type the palette offers. */
export interface NodeSpec {
  type: string;
  /** The palette group: Logic, Email, GitHub, Webhooks, Docs, … */
  group: string;
  label: string;
  /** A connector's settings are its `input`; a built-in node's are the node's own fields. */
  connector: boolean;
  /** The edges it leaves by: `next`, `then` + `else` (a condition), none (an end). */
  edges: EdgeField[];
  /** The settings: the connector's input schema, or the node's schema without key, type and edges. */
  settings: JsonSchema;
  /** What its step's output holds (placeholders and conditions read it); none when it has none. */
  output?: JsonSchema;
}

export interface TriggerSpec {
  type: string;
  label: string;
  /** The trigger's fields, without `type`. */
  settings: JsonSchema;
}

export interface Catalog {
  triggers: TriggerSpec[];
  nodes: NodeSpec[];
}

/** A credential as the builder sees it: never its meta or its secret. */
export interface CredentialRef {
  id: string;
  name: string;
  kind: CredentialKind;
}

export type RawNode = Record<string, unknown> & { key?: unknown; type?: unknown };

/** The draft definition as saved: the v2 shape, any field possibly missing or wrong. */
export interface Draft {
  version: 2;
  key: string;
  trigger: Record<string, unknown>;
  start: string;
  nodes: RawNode[];
  layout?: Record<string, { x: number; y: number }>;
  [other: string]: unknown;
}
