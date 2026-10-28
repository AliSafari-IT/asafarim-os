import { createWorkflowAction } from "@/app/actions";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { buildCatalog } from "@/lib/builder/catalog";
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
  return (
    <Shell current="/workflows">
      <h1>New workflow</h1>
      <ErrorNotice error={error} permission={permission} />
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
