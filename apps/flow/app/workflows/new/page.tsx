import { createWorkflowAction, generateWorkflowAction } from "@/app/actions";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { buildCatalog } from "@/lib/builder/catalog";
import { listCredentials } from "@/lib/credentials/store";
import { db } from "@/lib/db";
import { availability, type Unavailable as GenerateUnavailable } from "@/lib/generate/service";
import { pageAccess } from "@/lib/page";

export const dynamic = "force-dynamic";

/** New workflow (flow.workflows.write): its name, key and trigger; then the builder on its first draft. */
export default async function NewWorkflow({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess("flow.workflows.write");
  if (!access.ok) {
    return (
      <Shell current="/workflows">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { error, permission } = await searchParams;
  const { triggers } = buildCatalog();
  // Generate from issue (#283): only for who may, and shown disabled, with why, while it isn't available.
  const mayGenerate = access.permissions.includes("flow.workflows.generate");
  const pool = mayGenerate ? await db() : undefined;
  const generate = pool ? await availability(pool) : undefined;
  const tokens = pool
    ? (await listCredentials(pool)).filter((c) => c.kind === "github-token" || c.kind === "gitlab-token")
    : [];
  return (
    <Shell current="/workflows">
      <h1>New workflow</h1>
      <ErrorNotice error={error} permission={permission} />
      {generate ? <GenerateFromIssue available={generate} tokens={tokens} /> : null}
      <form action={createWorkflowAction} className="card" data-testid="new-workflow-form">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" required maxLength={200} data-testid="new-name" />
        <label htmlFor="key">Key</label>
        <input
          id="key"
          name="key"
          required
          maxLength={64}
          pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
          aria-describedby="key-hint"
          spellCheck={false}
          data-testid="new-key"
        />
        <p id="key-hint" className="muted hint">
          Lower case letters, digits and dashes, such as <span className="mono">notify-on-issue</span>. It can&apos;t be
          changed later.
        </p>
        <label htmlFor="trigger">Started by</label>
        <select id="trigger" name="trigger" defaultValue="manual" data-testid="new-trigger">
          {triggers.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="actions">
          <button type="submit" data-testid="new-submit">
            Create and open the builder
          </button>
          <a href="/workflows">Cancel</a>
        </div>
      </form>
    </Shell>
  );
}

const UNAVAILABLE: Record<GenerateUnavailable, string> = {
  switch_off: "Turned off. An admin can turn it on in Settings.",
  not_configured: "Not set up on this server.",
  paused: "Flow is paused, so nothing is sent out.",
  cooling_down: "The AI hasn't been answering; try again in a few minutes.",
};

/** The "Generate from issue" panel: an issue URL, an optional read token, and the AI drafts a workflow. */
function GenerateFromIssue({
  available,
  tokens,
}: {
  available: Awaited<ReturnType<typeof availability>>;
  tokens: { id: string; name: string; kind: string }[];
}) {
  const disabled = !available.ok;
  return (
    <form
      action={generateWorkflowAction}
      className="card"
      data-testid="generate-form"
      aria-labelledby="generate-heading"
    >
      <h2 id="generate-heading">Generate from an issue (AI)</h2>
      <p className="muted hint">
        Paste a GitHub or GitLab issue. An AI (Anthropic Claude) reads it and suggests a draft for you to review: it is
        never published or run by itself, and outgoing steps are left for you to configure. The issue&apos;s text is
        sent to Anthropic.
      </p>
      {disabled ? (
        <p className="notice" role="status" data-testid="generate-unavailable">
          {UNAVAILABLE[available.reason]} You can still build the workflow by hand below.
        </p>
      ) : null}
      <label htmlFor="issue-url">Issue URL</label>
      <input
        id="issue-url"
        name="issueUrl"
        type="url"
        required
        maxLength={2048}
        placeholder="https://github.com/owner/repo/issues/123"
        spellCheck={false}
        disabled={disabled}
        data-testid="generate-url"
      />
      <label htmlFor="issue-credential">Token for a private issue (optional)</label>
      <select
        id="issue-credential"
        name="credential"
        defaultValue=""
        disabled={disabled}
        data-testid="generate-credential"
      >
        <option value="">None: the issue is public</option>
        {tokens.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.kind === "gitlab-token" ? "GitLab" : "GitHub"})
          </option>
        ))}
      </select>
      <div className="actions">
        <button type="submit" disabled={disabled} data-testid="generate-submit">
          Generate a draft
        </button>
        <span className="muted hint">This can take up to a minute.</span>
      </div>
    </form>
  );
}
