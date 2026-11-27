import { cookies } from "next/headers";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Flash } from "@/components/Flash";
import { coreApi, derivedFrom } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { identityApi } from "@/lib/identity-api";
import { findPeople, ROLES_QUERY_COOKIE } from "@/lib/users";
import { formatTime, isAppId, isSubject } from "@/lib/util";
import { grantRole, mapRole, revokeRole, searchRolePeople, unmapRole } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roles & grants · Admin · ASafariM OS" };

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const api = coreApi(admin.idToken);
  // A removed app has nothing to grant (its roles are deprecated): not offered here.
  const apps = (await api.apps()).filter((a) => a.state !== "removed");
  // The first app with something to grant, unless one is asked for.
  const appId =
    isAppId(params.app) && apps.some((a) => a.id === params.app)
      ? params.app
      : (apps.find((a) => a.roles > 0)?.id ?? apps[0]?.id);
  // The search text can be an email address: it is kept in a cookie (searchRolePeople), never in the URL. `?q=` still
  // works for links made before.
  const q = ((await cookies()).get(ROLES_QUERY_COOKIE)?.value ?? params.q ?? "").slice(0, 100);
  // Opened from a person's profile (/admin/users/<id>): that person is chosen, and named, before anything is granted.
  const chosen = isSubject(params.subject) ? params.subject : undefined;

  const [roles, allRoles, mappings] = await Promise.all([
    appId ? api.roles(appId) : Promise.resolve([]),
    api.roles(),
    api.roleMappings(),
  ]);
  const holders = await Promise.all(roles.map((r) => api.roleGrants(r.key)));
  const mappingById = new Map(mappings.map((m) => [m.id, m]));
  // ADR 0004: any active role can be a source; a target is never a core role.
  const sources = allRoles.filter((r) => !r.deprecated);
  const targets = sources.filter((r) => !r.key.startsWith("core."));
  const grantable = roles.filter((r) => !r.deprecated);
  const [{ people, source }, chosenPerson, chosenGrants] = await Promise.all([
    findPeople(admin.idToken, q),
    chosen
      ? identityApi(admin.idToken)
          .user(chosen)
          .catch(() => null)
      : Promise.resolve(null),
    chosen ? api.subjectGrants(chosen) : Promise.resolve([]),
  ]);
  const here = `/admin/roles?${new URLSearchParams({ ...(appId ? { app: appId } : {}), ...(chosen ? { subject: chosen } : {}) })}`;
  const chosenName = chosenPerson?.label ?? chosen;
  const chosenHere = chosenGrants.filter((g) => g.appId === appId).map((g) => g.role);

  return (
    <>
      <h2>Roles &amp; grants</h2>
      <p className="muted">
        Apps declare roles; only an administrator grants them. A role gives the person its permissions in that app,
        within a minute of the change.
      </p>
      <Flash notice={params.notice} error={params.error} />

      <nav aria-label="Choose an app">
        <ul className="chips">
          {apps.map((a) => (
            <li key={a.id}>
              <Link
                href={`/admin/roles?${new URLSearchParams({ app: a.id, ...(chosen ? { subject: chosen } : {}) })}`}
                aria-current={a.id === appId ? "page" : undefined}
                style={a.id === appId ? { fontWeight: 700 } : undefined}
              >
                {a.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {roles.length === 0 ? (
        <p className="muted" data-testid="no-roles">
          {appId ? `${appId} hasn't declared any roles yet. They appear once the app has registered.` : "No apps yet."}
        </p>
      ) : (
        roles.map((role, i) => {
          const heading = `role-${role.key}`;
          return (
            <section key={role.key} className="card" aria-labelledby={heading} data-testid={`role-${role.key}`}>
              <h3 id={heading} style={{ marginTop: 0 }}>
                <span className="mono">{role.key}</span>{" "}
                {role.deprecated ? <span className="badge deprecated">deprecated</span> : null}
              </h3>
              {role.description ? <p className="muted">{role.description}</p> : null}
              <p>
                Grants:{" "}
                {role.permissions.length === 0
                  ? "nothing"
                  : role.permissions.map((p) => (
                      <span key={p.key} style={{ marginRight: 8 }}>
                        <code>{p.key}</code>
                        {p.deprecated ? <span className="badge deprecated">deprecated</span> : null}
                      </span>
                    ))}
              </p>
              {role.migrationNeeded ? (
                <div className="notice warn" role="note" data-testid={`migration-${role.key}`}>
                  <strong>Migration needed.</strong> This role still grants{" "}
                  {role.deprecatedPermissions.map((p, n) => (
                    <span key={p}>
                      {n > 0 ? ", " : ""}
                      <code>{p}</code>
                    </span>
                  ))}
                  , which the app no longer declares. Deprecated permissions stay until no role grants them: move the
                  people on this role to its replacement, then the permission can go.
                </div>
              ) : null}
              <p className="muted" style={{ marginBottom: 0 }}>
                Held by {role.holders === 0 ? "nobody" : `${role.holders} ${role.holders === 1 ? "person" : "people"}`}
              </p>
              <ul className="chips" aria-label={`People who hold ${role.key}`}>
                {holders[i]!.map((g) => {
                  const via = derivedFrom(g.granted_by);
                  const mapping = via === null ? undefined : mappingById.get(via);
                  return via !== null ? (
                    // A derived grant isn't revoked here: revoke the source role or delete the mapping.
                    <li key={g.subject} data-testid={`holder-${role.key}-${g.subject}`}>
                      <span className="mono">{g.subject}</span>
                      <span
                        className="muted"
                        title={`Holds it through mapping ${via} since ${formatTime(g.granted_at)}. Revoke the source role or delete the mapping to take it away.`}
                      >
                        through {mapping ? <span className="mono">{mapping.source}</span> : `mapping ${via}`}
                      </span>
                    </li>
                  ) : (
                    <li key={g.subject} data-testid={`holder-${role.key}-${g.subject}`}>
                      <span className="mono">{g.subject}</span>
                      <span className="muted" title={`Granted by ${g.granted_by} at ${formatTime(g.granted_at)}`}>
                        by {g.granted_by}
                      </span>
                      <ConfirmDialog
                        triggerLabel="Revoke"
                        triggerAriaLabel={`Revoke ${role.key} from ${g.subject}`}
                        title={`Revoke ${role.key}?`}
                        description={`${g.subject} loses the permissions this role gives, within a minute. You can grant it again.`}
                        confirmLabel="Revoke"
                        danger
                        action={revokeRole}
                        fields={{ role: role.key, subject: g.subject, next: here }}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      {chosen && grantable.length > 0 ? (
        <section className="card" aria-labelledby="chosen-h" data-testid="chosen-person">
          <h3 id="chosen-h" style={{ marginTop: 0 }}>
            Granting to <span style={{ overflowWrap: "anywhere" }}>{chosenName}</span>
          </h3>
          <p className="muted mono" style={{ overflowWrap: "anywhere" }}>
            Account ID {chosen}
            {chosenPerson?.state === "suspended" ? (
              <span className="badge removed">suspended: can&apos;t sign in</span>
            ) : null}
          </p>
          <p>
            {chosenHere.length ? (
              <>
                Holds in {appId}:{" "}
                {chosenHere.map((r) => (
                  <code key={r} style={{ marginRight: 8 }}>
                    {r}
                  </code>
                ))}
              </>
            ) : (
              <span className="muted">Holds no role in {appId} yet.</span>
            )}
          </p>
          <form action={grantRole} className="row" aria-label={`Grant a role to ${chosenName}`}>
            <input type="hidden" name="subject" value={chosen} />
            <input type="hidden" name="next" value={here} />
            <div>
              <label htmlFor="chosen-role">Role in {appId}</label>
              <select id="chosen-role" name="role">
                {grantable.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.key}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" data-testid="chosen-grant">
              Grant to {chosenName}
            </button>
          </form>
          <p style={{ marginBottom: 0 }}>
            <Link href={`/admin/users/${encodeURIComponent(chosen)}`}>Back to this person</Link>
            {" · "}
            <Link href={`/admin/roles?${new URLSearchParams(appId ? { app: appId } : {})}`}>Choose someone else</Link>
          </p>
        </section>
      ) : null}

      {grantable.length > 0 ? (
        <>
          <h3>Grant a role in {appId}</h3>
          <form action={searchRolePeople} className="row" aria-label="Find a person">
            {appId ? <input type="hidden" name="app" value={appId} /> : null}
            <div>
              <label htmlFor="user-q">Find a person</label>
              <input id="user-q" name="q" defaultValue={q} placeholder="name, email or id" maxLength={100} />
            </div>
            <button type="submit" className="secondary">
              Search
            </button>
          </form>

          {people.length === 0 ? (
            <p className="muted">
              {q
                ? `Nobody matches "${q}".`
                : source === "none"
                  ? "No people directory is available here."
                  : "Nobody yet."}{" "}
              You can still grant by subject id below.
            </p>
          ) : (
            <div className="table-wrap os-table-wrap">
              <table className="os-table os-table--stack">
                <caption>
                  {source === "identity" ? "People (from identity)" : "People (the seeded local users)"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Role to grant</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((u) => (
                    <tr key={u.id} data-testid={`person-${u.id}`}>
                      <th scope="row">
                        {u.name}
                        <div className="muted mono">
                          {u.id} · {u.email}
                        </div>
                        {u.isActive ? null : <span className="badge warn">inactive: can&apos;t sign in</span>}
                      </th>
                      <td data-label="Role to grant">
                        <form action={grantRole} className="row" aria-label={`Grant a role to ${u.name}`}>
                          <input type="hidden" name="subject" value={u.id} />
                          <input type="hidden" name="next" value={here} />
                          <select name="role" aria-label={`Role for ${u.name}`}>
                            {grantable.map((r) => (
                              <option key={r.key} value={r.key}>
                                {r.key}
                              </option>
                            ))}
                          </select>
                          <button type="submit" aria-label={`Grant the selected role to ${u.name}`}>
                            Grant
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form action={grantRole} className="card row" aria-label="Grant by subject id">
            <input type="hidden" name="next" value={here} />
            <div>
              <label htmlFor="subject-id">Or a subject id</label>
              <input id="subject-id" name="subject" placeholder="the person's identity id" maxLength={128} required />
            </div>
            <div>
              <label htmlFor="subject-role">Role</label>
              <select id="subject-role" name="role">
                {grantable.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.key}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit">Grant</button>
          </form>
        </>
      ) : null}

      <section aria-labelledby="mappings-heading" data-testid="role-mappings">
        <h3 id="mappings-heading">Role mappings</h3>
        <p className="muted">
          Whoever holds the source role also holds the target, for as long as they hold the source. A mapping never
          gives a core role, and it isn&apos;t chained: only a role someone was granted directly counts as a source.
          Deleting a mapping takes away only the grants it made.
        </p>
        {mappings.length === 0 ? (
          <p className="muted" data-testid="no-mappings">
            No mappings yet.
          </p>
        ) : (
          <div className="table-wrap os-table-wrap">
            <table className="os-table os-table--stack">
              <caption>Role mappings</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Target</th>
                  <th scope="col">Holders through it</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id} data-testid={`mapping-${m.source}-${m.target}`}>
                    <th scope="row" className="mono">
                      {m.source}
                    </th>
                    <td data-label="Target" className="mono">
                      {m.target}
                    </td>
                    <td data-label="Holders through it">{m.derivedGrants}</td>
                    <td data-label="Created">
                      {formatTime(m.createdAt)} <span className="muted">by {m.createdBy}</span>
                    </td>
                    <td data-label="Actions">
                      <ConfirmDialog
                        triggerLabel="Delete"
                        triggerAriaLabel={`Delete the mapping ${m.source} to ${m.target}`}
                        title={`Delete the mapping ${m.source} → ${m.target}?`}
                        description={`${m.derivedGrants} ${m.derivedGrants === 1 ? "person loses" : "people lose"} ${m.target} within a minute, unless another mapping or a direct grant gives it to them. You can add the mapping again.`}
                        confirmLabel="Delete"
                        danger
                        action={unmapRole}
                        fields={{ id: String(m.id), next: here }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {sources.length > 0 && targets.length > 0 ? (
          <form action={mapRole} className="card row" aria-label="Add a role mapping">
            <input type="hidden" name="next" value={here} />
            <div>
              <label htmlFor="mapping-source">Whoever holds</label>
              <select id="mapping-source" name="source">
                {sources.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.key}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="mapping-target">also holds</label>
              <select id="mapping-target" name="target">
                {targets.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.key}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit">Add mapping</button>
          </form>
        ) : null}
      </section>
    </>
  );
}
