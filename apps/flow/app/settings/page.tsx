import {
  saveEgressHostsAction,
  saveEmailRecipientsAction,
  setAiGenerationAction,
  setPausedAllAction,
} from "@/app/actions";
import { ErrorNotice, SavedNotice, Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { db } from "@/lib/db";
import { pageAccess } from "@/lib/page";
import { aiConfigFromEnv } from "@/lib/generate/provider";
import { getSettings, LIST_MAX } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Flow's settings: the hosts webhook out may call, who email may go to, and Pause all (no run starts,
 * no call goes out) / Resume all. Read with flow.read; changed with flow.settings.write.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess();
  if (!access.ok) {
    return (
      <Shell current="/settings">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { error, permission, saved } = await searchParams;
  const settings = await getSettings(await db());
  const canWrite = access.permissions.includes("flow.settings.write");
  return (
    <Shell current="/settings">
      <h1>Settings</h1>
      <ErrorNotice error={error} permission={permission} />
      <SavedNotice saved={saved} />
      <section className="card" data-testid="paused-all" data-paused={settings.pausedAll ? "on" : "off"}>
        <h2>Pause all</h2>
        {settings.pausedAll ? (
          <p className="notice bad" role="status">
            Flow is paused: no run starts and no call goes out until it is resumed.
          </p>
        ) : (
          <p className="muted">Flow is running. Pause all stops new runs and every outbound call at once.</p>
        )}
        {canWrite ? (
          <form action={setPausedAllAction}>
            <input type="hidden" name="pausedAll" value={settings.pausedAll ? "off" : "on"} />
            <button
              type="submit"
              className={settings.pausedAll ? undefined : "secondary"}
              data-testid="toggle-paused-all"
            >
              {settings.pausedAll ? "Resume all" : "Pause all"}
            </button>
          </form>
        ) : null}
      </section>
      <section className="card" data-testid="ai-generation" data-enabled={settings.aiGeneration ? "on" : "off"}>
        <h2>Generate drafts from issues (AI)</h2>
        <p>
          Lets people with <span className="perm">flow.workflows.generate</span> paste a GitHub or GitLab issue URL and
          get a suggested workflow draft.{" "}
          <strong>
            The issue&apos;s title, description and first comments are sent to an external AI provider, Anthropic
            (Claude),
          </strong>{" "}
          after anything that looks like a secret is removed. The draft is never published or run by itself, and its
          outgoing steps are left unconfigured.
        </p>
        {settings.aiGeneration ? (
          <p className="notice warn" role="status">
            On: issue text is sent to Anthropic when someone generates a draft.
          </p>
        ) : (
          <p className="muted">Off: nothing is sent, and the action is not offered.</p>
        )}
        {!aiConfigFromEnv() ? (
          <p className="muted">
            Not configured on this server (no FLOW_AI_API_KEY): it stays unavailable even when on.
          </p>
        ) : null}
        {canWrite ? (
          <form action={setAiGenerationAction}>
            <input type="hidden" name="aiGeneration" value={settings.aiGeneration ? "off" : "on"} />
            <button type="submit" className="secondary" data-testid="toggle-ai-generation">
              {settings.aiGeneration ? "Turn off" : "Turn on and allow sending issues to Anthropic"}
            </button>
          </form>
        ) : null}
      </section>
      <ListForm
        title="Webhook hosts"
        hint={`The hosts webhook out may call, one per line: a host name, or host:port for a port other than 443. At most ${LIST_MAX}.`}
        entries={settings.egressHosts}
        action={saveEgressHostsAction}
        canWrite={canWrite}
        testId="egress-hosts"
      />
      <ListForm
        title="Email recipients"
        hint={`Who email may go to, one per line: an address, or @domain for everyone there. At most ${LIST_MAX}.`}
        entries={settings.emailRecipients}
        action={saveEmailRecipientsAction}
        canWrite={canWrite}
        testId="email-recipients"
      />
    </Shell>
  );
}

function ListForm({
  title,
  hint,
  entries,
  action,
  canWrite,
  testId,
}: {
  title: string;
  hint: string;
  entries: string[];
  action: (f: FormData) => Promise<void>;
  canWrite: boolean;
  testId: string;
}) {
  const id = `${testId}-entries`;
  return (
    <form action={action} className="card" data-testid={testId}>
      <h2>{title}</h2>
      <label htmlFor={id}>Entries</label>
      <textarea id={id} name="entries" rows={6} defaultValue={entries.join("\n")} readOnly={!canWrite} />
      <p className="muted hint">{hint}</p>
      {canWrite ? <button type="submit">Save</button> : null}
    </form>
  );
}
