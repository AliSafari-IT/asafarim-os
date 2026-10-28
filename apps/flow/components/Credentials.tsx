/**
 * The credentials as the page lists them: name, kind, what isn't secret (meta), created, rotated and
 * last used. It is given summaries (lib/credentials/store.ts listCredentials), which hold no secret.
 */
import { deleteCredentialAction } from "@/app/actions";
import { RotateCredentialForm } from "@/components/CredentialForms";
import type { CredentialSummary } from "@/lib/credentials/store";
import { at } from "@/lib/format";

const KIND_LABEL = { smtp: "SMTP", "github-token": "GitHub token", "webhook-secret": "Webhook secret" } as const;

function details(c: CredentialSummary): string {
  const m = c.meta;
  if (c.kind === "smtp") return `${String(m.host)}:${String(m.port)} (${String(m.mode)}), from ${String(m.from)}`;
  if (c.kind === "github-token") return Array.isArray(m.repos) ? m.repos.join(", ") : "";
  return "";
}

export function CredentialTable({ credentials, canUse }: { credentials: CredentialSummary[]; canUse: boolean }) {
  if (!credentials.length) return <p className="muted">No credentials yet.</p>;
  return (
    <div className="table-wrap">
      <table data-testid="credentials">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Details</th>
            <th>Created</th>
            <th>Rotated</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {credentials.map((c) => (
            <tr key={c.id} data-testid="credential" data-kind={c.kind}>
              <td>{c.name}</td>
              <td>{KIND_LABEL[c.kind]}</td>
              <td className="mono">{details(c)}</td>
              <td>{at(c.createdAt)}</td>
              <td>{at(c.rotatedAt)}</td>
              <td>{at(c.lastUsedAt)}</td>
              <td>
                {canUse ? <RotateCredentialForm id={c.id} kind={c.kind} name={c.name} /> : null}
                <form action={deleteCredentialAction}>
                  <input type="hidden" name="credentialId" value={c.id} />
                  <button type="submit" className="secondary" data-testid="delete">
                    Delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
