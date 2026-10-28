/**
 * The Credentials page's forms, as the store takes them (lib/credentials/store.ts validates), and what
 * an add or rotate answers the form with. The answer carries a secret only for a webhook secret Flow
 * just generated: it is shown that once and kept nowhere (not in the URL, not in a cookie).
 */
import type { CredentialKind } from "./store";

export type CredentialFormState =
  | { status: "idle" }
  | { status: "error"; error: string; permission?: string }
  | { status: "done"; kind: CredentialKind; secret?: string };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/** Repositories as typed: comma-, space- or line-separated, each once. */
const reposOf = (raw: string) => [
  ...new Set(
    raw
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter(Boolean),
  ),
];

/** The secret fields of a kind (what an add and a rotate send). */
function secretOf(kind: string, f: FormData) {
  if (kind === "smtp") return { username: str(f, "username"), password: str(f, "password") };
  if (kind === "github-token") return { token: str(f, "token").trim() };
  return undefined;
}

export function creationFrom(f: FormData): unknown {
  const kind = str(f, "kind");
  const name = str(f, "name");
  if (kind === "smtp")
    return {
      kind,
      name,
      meta: { host: str(f, "host"), port: str(f, "port") || "587", mode: str(f, "mode"), from: str(f, "from") },
      secret: secretOf(kind, f),
    };
  if (kind === "github-token")
    return { kind, name, meta: { repos: reposOf(str(f, "repos")) }, secret: secretOf(kind, f) };
  return { kind, name };
}

export function rotationFrom(f: FormData): unknown {
  const kind = str(f, "kind");
  const secret = secretOf(kind, f);
  return secret ? { kind, secret } : { kind };
}
