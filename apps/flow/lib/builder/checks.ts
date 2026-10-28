/**
 * The builder's validation (server only): the definition's own checks (the engine's: v2 schema, the
 * graph, what each node reads, the manifest) and those that need Flow's data, each on its node:
 *
 * - a credential field must name a credential of its kind that exists;
 * - a webhook URL's host must be on Settings `egress_hosts`;
 * - an email recipient must be on Settings `email_recipients`.
 *
 * The fields are found by their marks in the connectors' input schemas (lib/workflow/fields.ts). A
 * value with a placeholder is only known when the run fills it in: the connector checks it then.
 * Publishing is refused while any of these finds a problem (app/actions.ts `publishDraft`).
 */
import type { z } from "zod";
import { listCredentials } from "../credentials/store";
import { allowListOf, isAllowed } from "../egress/hosts";
import { connectors as registry, type ConnectorRegistry } from "../engine/connectors";
import { getSettings, isRecipientAllowed, type Queryable } from "../settings";
import { fieldMark } from "../workflow/fields";
import { KEY, type Problem } from "../workflow/schema";
import { unwrap, walkStrings } from "../workflow/templates";
import type { CredentialRef } from "./types";

export interface CheckData {
  credentials: readonly CredentialRef[];
  egressHosts: readonly string[];
  emailRecipients: readonly string[];
}

/** What the checks read: the credentials (ids, names and kinds only) and the two allow-lists. */
export async function checkDataOf(q: Queryable): Promise<CheckData> {
  const [credentials, settings] = await Promise.all([listCredentials(q), getSettings(q)]);
  return {
    credentials: credentials.map(({ id, name, kind }) => ({ id, name, kind })),
    egressHosts: settings.egressHosts,
    emailRecipients: settings.emailRecipients,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pathOf = (path: readonly PropertyKey[]) => path.map(String).join(".");

/** The problems only Flow's data shows (credentials, allow-lists), by node. */
export function dataProblems(draft: unknown, data: CheckData, connectors: ConnectorRegistry = registry): Problem[] {
  const problems: Problem[] = [];
  const nodes = isRecord(draft) && Array.isArray(draft.nodes) ? draft.nodes : [];
  const allow = allowListOf(data.egressHosts);
  nodes.forEach((node, i) => {
    if (!isRecord(node) || typeof node.type !== "string") return;
    const connector = connectors.get(node.type);
    if (!connector) return;
    const who = typeof node.key === "string" && KEY.test(node.key) ? node.key : `#${i}`;
    const input = isRecord(node.input) ? node.input : {};
    const add = (path: readonly PropertyKey[], message: string) =>
      problems.push({ node: who, path: pathOf(["input", ...path]), message });

    const shape = (unwrap(connector.input) as z.ZodObject).def.shape as Record<string, z.ZodType> | undefined;
    for (const [field, schema] of Object.entries(shape ?? {})) {
      const mark = fieldMark(unwrap(schema));
      if (!mark || !("credential" in mark)) continue;
      const id = input[field];
      if (typeof id !== "string" || !id) {
        add([field], `choose a ${mark.credential} credential`);
        continue;
      }
      const found = data.credentials.find((c) => c.id === id);
      if (!found) add([field], "the credential doesn't exist (any more): choose another");
      else if (found.kind !== mark.credential)
        add([field], `"${found.name}" is a ${found.kind} credential, not ${mark.credential}`);
    }

    walkStrings(connector.input, input, (path, text, _templated, schema) => {
      const mark = fieldMark(schema);
      if (!mark || text.includes("{{")) return;
      if ("egress" in mark) {
        let url: URL;
        try {
          url = new URL(text);
        } catch {
          return; // the schema reports it
        }
        const port = url.port ? Number(url.port) : 443;
        if (!isAllowed(allow, url.hostname, port))
          add(path, `${url.host} isn't on the allowed hosts (Settings, egress hosts)`);
      }
      if ("recipient" in mark && text.trim() && !isRecipientAllowed(data.emailRecipients, text))
        add(path, `${text.trim()} isn't an allowed recipient (Settings, email recipients)`);
    });
  });
  return problems;
}

/** Every problem the builder shows: the definition's own (`own`, the engine's checks) and the data's. */
export function builderProblems(
  draft: unknown,
  own: readonly Problem[],
  data: CheckData,
  connectors: ConnectorRegistry = registry,
): Problem[] {
  return [...own, ...dataProblems(draft, data, connectors)];
}
