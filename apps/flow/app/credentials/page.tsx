import { CredentialTable } from "@/components/Credentials";
import { AddCredentialForm } from "@/components/CredentialForms";
import { ErrorNotice, Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { credentialsAvailable, listCredentials } from "@/lib/credentials/store";
import { db } from "@/lib/db";
import { pageAccess } from "@/lib/page";

export const dynamic = "force-dynamic";

/**
 * The credentials connectors use (flow.credentials.write): listed by name and kind, added, rotated and
 * deleted. Secrets are never shown, except a generated webhook secret, once, by the form that made it.
 * Without FLOW_CREDENTIALS_KEY on the server nothing can be added or rotated (deleting still works).
 */
export default async function Credentials({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess("flow.credentials.write");
  if (!access.ok) {
    return (
      <Shell current="/credentials">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { error, permission } = await searchParams;
  const available = credentialsAvailable();
  const credentials = await listCredentials(await db());
  return (
    <Shell current="/credentials">
      <h1>Credentials</h1>
      <ErrorNotice error={error} permission={permission} />
      {available ? null : (
        <p className="notice warn" role="status" data-testid="credentials-unavailable">
          Credentials aren&apos;t set up on this server.
        </p>
      )}
      <section className="card">
        <CredentialTable credentials={credentials} canUse={available} />
      </section>
      {available ? <AddCredentialForm /> : null}
    </Shell>
  );
}
