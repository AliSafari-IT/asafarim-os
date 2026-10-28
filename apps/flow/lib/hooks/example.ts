/**
 * What the Workflows page shows for a hook: its URL, a curl example that signs a test payload the way
 * the hook checks it (lib/hooks/signature.ts), and the answer a create or a regeneration gives its
 * form. No Node imports: the form renders these in the browser, where the secret is shown once.
 */
import type { InputField } from "../workflow/definition-v2";
import type { HookKind } from "./store";

export type HookFormState =
  | { status: "idle" }
  | { status: "error"; error: string; permission?: string }
  | { status: "done"; hookId: string; kind: HookKind; secret?: string };

/** Where a hook is called: the app's primary domain. */
export const hookUrl = (domain: string, id: string) => `https://${domain}/hooks/${id}`;

/** A test body for a generic hook: each input field with a sample value. */
export function sampleBody(fields: readonly InputField[]): string {
  const sample = { string: "test", number: 1, boolean: true } as const;
  return JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, sample[f.type]])));
}

/** In single quotes for sh: nothing inside is expanded. */
const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A shell script that signs `body` and POSTs it to `url`. Without `secret`, a placeholder stands in
 * for it: the secret is only ever filled in by the view that shows it once.
 */
export function curlExample(opts: { url: string; kind: HookKind; body: string; secret?: string }): string {
  const secret = opts.secret ? quoted(opts.secret) : "'<the secret shown when it was generated>'";
  if (opts.kind === "github")
    return [
      `SECRET=${secret}`,
      `BODY='{"zen":"Keep it logically awesome."}'`,
      `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
      `curl -sS -X POST ${quoted(opts.url)} \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'X-GitHub-Event: ping' \\`,
      `  -H "X-GitHub-Delivery: test-$(date +%s)" \\`,
      `  -H "X-Hub-Signature-256: sha256=$SIG" \\`,
      `  --data-binary "$BODY"`,
    ].join("\n");
  return [
    `SECRET=${secret}`,
    `BODY=${quoted(opts.body)}`,
    `T=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
    `curl -sS -X POST ${quoted(opts.url)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "X-Flow-Signature: t=$T,v1=$SIG" \\`,
    `  -H "X-Flow-Delivery: test-$T" \\`,
    `  --data-binary "$BODY"`,
  ].join("\n");
}
