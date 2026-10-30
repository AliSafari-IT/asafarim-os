/**
 * What a connector's input schema says about a field beyond its type, for the builder and its checks
 * (lib/builder): which credential kind a field holds the id of, and which text is a URL checked against
 * Settings `egress_hosts` or an address checked against `email_recipients`. Marks only: the connector
 * still checks each of these itself when it runs. Placeholders are marked by `templatedText()`
 * (lib/workflow/templates.ts).
 */
import { z } from "zod";
import type { CredentialKind } from "../credentials/store";

export type FieldMark = { credential: CredentialKind } | { egress: true } | { recipient: true };

const marks = z.registry<FieldMark>();

/** The id of a credential of `kind` (`smtp`, `github-token`, `gitlab-token`, `webhook-secret`). */
export function credentialField(kind: CredentialKind): z.ZodString {
  const schema = z.string().min(1).max(64);
  marks.add(schema, { credential: kind });
  return schema;
}

/** A URL whose host must be on Settings `egress_hosts`. */
export function egressUrl<S extends z.ZodType>(schema: S): S {
  marks.add(schema, { egress: true });
  return schema;
}

/** An email address that must be on Settings `email_recipients` (the address, or its "@domain"). */
export function emailRecipient<S extends z.ZodType>(schema: S): S {
  marks.add(schema, { recipient: true });
  return schema;
}

/** The mark `schema` carries, if any. */
export const fieldMark = (schema: z.ZodType | undefined): FieldMark | undefined =>
  schema ? marks.get(schema) : undefined;
