/**
 * Users: start from a person. Who is this, which apps can they use and why, and where do I change that? The
 * directory comes from identity (core/identity `GET /admin/v1/users`, the administrator's own ID token, uncached);
 * each person opens their profile at /admin/users/<account id>. Roles & grants stays the place for an administrator
 * who starts from an app or a role.
 */
import { cookies } from "next/headers";
import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { Flash } from "@/components/Flash";
import { personLabel, SCOPE_TEXT, STATE_TEXT } from "@/lib/access";
import { directoryHref, parseView, USERS_QUERY_COOKIE } from "@/lib/directory";
import {
  directoryState,
  identityApi,
  type AccountState,
  type AdmissionScope,
  type DirectoryPerson,
} from "@/lib/identity-api";
import { requireAdmin } from "@/lib/session";
import { formatTime } from "@/lib/util";
import { clearDirectory, openPerson, searchDirectory } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users · Admin · ASafariM OS" };

const PAGE_SIZE = 25;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const view = parseView(params);
  const q = ((await cookies()).get(USERS_QUERY_COOKIE)?.value ?? "").slice(0, 200);
  const filtered = Boolean(q || view.state || view.scope);
  const here = directoryHref(view);

  let page: { users: DirectoryPerson[]; next: string | null } | null = null;
  let problem: "not-admin" | "unavailable" | null = null;
  try {
    page = await identityApi(admin.idToken).users({
      ...(q ? { q } : {}),
      ...(view.state ? { state: view.state as AccountState } : {}),
      ...(view.scope ? { scope: view.scope as AdmissionScope } : {}),
      ...(view.after ? { after: view.after } : {}),
      limit: PAGE_SIZE,
    });
  } catch (err) {
    problem = directoryState(err);
  }

  return (
    <>
      <h2>Users</h2>
      <p className="muted">
        Find a person, see which apps they can use and why, and go to the right place to change it. Accounts and
        admission come from identity; roles come from core-api.
      </p>
      <Flash notice={params.notice} error={params.error} />

      <form action={searchDirectory} className="card row" aria-label="Search users" data-testid="users-search">
        <div>
          <label htmlFor="users-q">Search by name, email, or account ID</label>
          <input id="users-q" name="q" defaultValue={q} maxLength={200} autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <label htmlFor="users-state">Account state</label>
          <select id="users-state" name="state" defaultValue={view.state ?? ""}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
        <div>
          <label htmlFor="users-scope">Admission</label>
          <select id="users-scope" name="scope" defaultValue={view.scope ?? ""}>
            <option value="">All</option>
            <option value="global">Every app</option>
            <option value="apps">Some apps</option>
            <option value="none">No app yet</option>
          </select>
        </div>
        <button type="submit">Search</button>
      </form>

      {filtered ? (
        <div className="row" data-testid="users-active-filters">
          <span className="muted">Showing </span>
          {q ? <span className="badge">search: {q}</span> : null}{" "}
          {view.state ? <span className="badge">state: {STATE_TEXT[view.state as AccountState]}</span> : null}{" "}
          {view.scope ? <span className="badge">admission: {SCOPE_TEXT[view.scope as AdmissionScope]}</span> : null}{" "}
          <form action={clearDirectory} style={{ display: "inline" }}>
            <button type="submit" className="secondary" data-testid="users-clear">
              Clear filters
            </button>
          </form>
        </div>
      ) : null}

      {problem === "not-admin" ? (
        <div className="notice warn" role="note" data-testid="users-forbidden">
          <strong>You don&apos;t have permission to view users.</strong> The directory is read from identity, which
          shows it only to an identity administrator. Ask one to make your account an identity admin, or open a person
          by their account ID below.
        </div>
      ) : problem === "unavailable" ? (
        <div className="notice warn" role="note" data-testid="users-unavailable">
          <strong>Directory unavailable.</strong> Identity didn&apos;t answer, or it runs without its own sign-in (Hub
          mode has no directory to list). You can still open a person by their account ID.{" "}
          <Link href={here}>Try again</Link>
        </div>
      ) : page && page.users.length === 0 ? (
        filtered ? (
          <div className="muted" data-testid="users-no-matches">
            No matches.{" "}
            <form action={clearDirectory} style={{ display: "inline" }}>
              <button type="submit" className="secondary">
                Clear filters
              </button>
            </form>
          </div>
        ) : (
          <p className="muted" data-testid="users-empty">
            No users yet. People appear here once they sign in or an administrator adds them in identity.
          </p>
        )
      ) : page ? (
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack" data-testid="users-table">
            <caption>People</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Account state</th>
                <th scope="col">Admission</th>
                <th scope="col">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {page.users.map((u) => (
                <tr key={u.id} data-testid={`user-${u.id}`}>
                  <th scope="row" style={{ overflowWrap: "anywhere" }}>
                    <Link href={`/admin/users/${u.id}?back=${encodeURIComponent(here)}`} data-testid="user-link">
                      {personLabel(u)}
                    </Link>
                    {u.isAdmin ? <span className="badge">identity admin</span> : null}
                    <div className="muted mono">
                      {u.id} <CopyButton value={u.id} />
                    </div>
                  </th>
                  <td data-label="Account state">
                    <span className={`badge ${u.state === "active" ? "active" : "removed"}`}>
                      {STATE_TEXT[u.state]}
                    </span>
                  </td>
                  <td data-label="Admission">
                    {SCOPE_TEXT[u.scope]}
                    {u.scope === "apps" ? (
                      <div className="muted" style={{ overflowWrap: "anywhere" }}>
                        {u.admittedClients.join(", ")}
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Last sign-in">
                    {u.lastLoginAt ? formatTime(u.lastLoginAt) : <span className="muted">never</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {page && (page.next || view.after) ? (
        <nav aria-label="Pages" className="row" data-testid="users-pages">
          {view.after ? <Link href={directoryHref({ ...view, after: undefined })}>← First page</Link> : null}
          {page.next ? (
            <Link href={directoryHref({ ...view, after: page.next })} data-testid="users-next">
              Next page →
            </Link>
          ) : null}
        </nav>
      ) : null}

      <form action={openPerson} className="card row" aria-label="Open a person by account ID">
        <div>
          <label htmlFor="users-subject">Open by exact account ID</label>
          <input id="users-subject" name="subject" maxLength={128} required spellCheck={false} />
        </div>
        <button type="submit" className="secondary">
          Open
        </button>
      </form>
    </>
  );
}
