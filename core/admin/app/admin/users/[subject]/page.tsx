/**
 * One person: who they are (identity), which apps they can use and why (identity's admission + core-api's roles,
 * lib/access.ts), what they did recently (identity's trail), and where to change it. Each source is read on its
 * own: when identity or its trail can't be read, the rest of the page still works and says what isn't known.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/CopyButton";
import { accessByApp, admissionText, personLabel, SCOPE_TEXT, STATE_TEXT, type IdentityFacts } from "@/lib/access";
import { coreApi, CoreApiError, type RoleMapping, type SubjectGrant } from "@/lib/core-api";
import { safeBack } from "@/lib/directory";
import { identityAdminUrl, identityApi, type PersonProfile, type SignInEvent } from "@/lib/identity-api";
import { requireAdmin } from "@/lib/session";
import { formatTime, isSubject } from "@/lib/util";

export const dynamic = "force-dynamic";
export const metadata = { title: "User · Admin · ASafariM OS" };

const ACTIVITY = 8;

/** A failed identity read, in the access summary's terms. */
function identityProblem(err: unknown): "unavailable" | "not-found" | "not-allowed" {
  if (err instanceof CoreApiError && err.status === 404) return "not-found";
  if (err instanceof CoreApiError && err.status === 403) return "not-allowed";
  return "unavailable";
}

/** An audit event's outcome in words, from its name (`login.granted`, `otp.verify_failed`, `admin.denied` …). */
function outcome(event: string): "succeeded" | "failed" | "info" {
  if (/(granted|verified|approved|connected|reconnected|admitted)$/.test(event)) return "succeeded";
  if (/(failed|denied|rejected|not_authorized|revoked|expired|blocked|refused|limited)$/.test(event)) return "failed";
  return "info";
}

export default async function UserPage({
  params,
  searchParams,
}: {
  params: Promise<{ subject: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const subject = decodeURIComponent((await params).subject);
  if (!isSubject(subject)) notFound();
  const back = safeBack((await searchParams).back);
  const api = coreApi(admin.idToken);
  const identity = identityApi(admin.idToken);

  const [profileResult, apps, grants, mappings, activityResult] = await Promise.all([
    identity.user(subject).then(
      (p): { ok: true; p: PersonProfile } => ({ ok: true, p }),
      (err: unknown) => ({ ok: false as const, reason: identityProblem(err) }),
    ),
    api.apps(),
    api.subjectGrants(subject),
    api.roleMappings().catch((): RoleMapping[] => []),
    identity.audit({ principal: subject, limit: ACTIVITY }).then(
      (r): { ok: true; events: SignInEvent[] } => ({ ok: true, events: r.events }),
      () => ({ ok: false as const }),
    ),
  ]);
  const person = profileResult.ok ? profileResult.p : null;
  const missing = profileResult.ok ? null : profileResult.reason;
  // Nobody in identity and nothing in core-api: there's no such person to show.
  if (missing === "not-found" && grants.length === 0) notFound();

  const facts: IdentityFacts = person ? { ok: true, person } : { ok: false, reason: missing ?? "unavailable" };
  const rows = accessByApp(apps, facts, grants as SubjectGrant[], mappings);
  const title = person ? personLabel(person) : `Account ${subject.slice(0, 8)}…`;
  const verification =
    !person || person.email === null
      ? person
        ? "No email address"
        : "Verification unknown"
      : person.emailVerified === true
        ? "Email verified"
        : person.emailVerified === false
          ? "Email not verified"
          : "Verification unknown";

  return (
    <>
      <p>
        <Link href={back} data-testid="back-to-users">
          ← Users
        </Link>
      </p>
      <h2 style={{ overflowWrap: "anywhere" }} data-testid="user-title">
        {title}
      </h2>

      {person?.state === "suspended" ? (
        <div className="notice warn" role="alert" data-testid="user-suspended">
          <strong>This account is suspended.</strong> It can&apos;t sign in to any app, whatever roles it still holds
          below. Lift the suspension in identity administration.
        </div>
      ) : null}

      <section className="card" aria-labelledby="overview-h" data-testid="user-overview">
        <h3 id="overview-h" style={{ marginTop: 0 }}>
          Overview
        </h3>
        <dl className="facts">
          <dt>Account ID</dt>
          <dd className="mono" style={{ overflowWrap: "anywhere" }}>
            {subject} <CopyButton value={subject} />
          </dd>
          <dt>Email</dt>
          <dd style={{ overflowWrap: "anywhere" }}>
            {person?.email ?? <span className="muted">{person ? "none" : "unknown"}</span>}{" "}
            <span className="muted" data-testid="user-verification">
              ({verification})
            </span>
          </dd>
          <dt>Account state</dt>
          <dd data-testid="user-state">{person ? STATE_TEXT[person.state] : "Unknown"}</dd>
          <dt>Admission</dt>
          <dd>{person ? SCOPE_TEXT[person.scope] : "Unknown"}</dd>
          {person ? (
            <>
              <dt>Signs in with</dt>
              <dd>
                {[...new Set(person.identities.map((i) => i.method))].join(", ") || "nothing yet"}
                {person.passkeys ? ` and ${person.passkeys} passkey${person.passkeys === 1 ? "" : "s"}` : ""}
              </dd>
              <dt>Last sign-in</dt>
              <dd>{person.lastLoginAt ? formatTime(person.lastLoginAt) : "never"}</dd>
              {person.pendingRequest ? (
                <>
                  <dt>Open request</dt>
                  <dd>
                    asked for access {formatTime(person.pendingRequest.createdAt)}
                    {person.pendingRequest.apps.length ? ` (${person.pendingRequest.apps.join(", ")})` : ""}
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
        {!person ? (
          <p className="muted" data-testid="user-identity-missing">
            {missing === "not-found"
              ? "Identity has no account with this ID: the roles below are stored for an ID that can't sign in."
              : missing === "not-allowed"
                ? "Identity shows accounts only to an identity administrator, so who this is and whether they can sign in isn't known here."
                : "Identity isn't available right now (or runs without its own sign-in), so who this is and whether they can sign in isn't known here."}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="access-h" data-testid="user-access">
        <h3 id="access-h">Access by app</h3>
        <p className="muted">
          Two separate facts per app: whether the account may sign in to it (identity), and which roles it holds there
          (core-api). A role alone doesn&apos;t let anyone in.
        </p>
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack">
            <caption>Access by app</caption>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Admission</th>
                <th scope="col">Roles, and why</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.appId} data-testid={`access-${r.appId}`}>
                  <th scope="row" style={{ overflowWrap: "anywhere" }}>
                    {r.appName} <span className="muted mono">{r.appId}</span>
                    {r.appState !== "active" ? <span className="badge inactive">{r.appState}</span> : null}
                  </th>
                  <td data-label="Admission" data-testid={`admission-${r.appId}`}>
                    {admissionText(r.admission)}
                  </td>
                  <td data-label="Roles, and why">
                    {r.roles.length === 0 ? (
                      <span className="muted">no role</span>
                    ) : (
                      <ul className="plain">
                        {r.roles.map(({ role, reason }) => (
                          <li key={role} data-testid={`role-${role}`}>
                            <code>{role}</code>{" "}
                            <span className="muted">
                              {reason.kind === "direct" ? (
                                <>
                                  · direct role grant by <span className="mono">{reason.grantedBy}</span>,{" "}
                                  {formatTime(reason.grantedAt)}
                                </>
                              ) : (
                                <>
                                  · through a role mapping from{" "}
                                  {reason.source ? <code>{reason.source}</code> : `mapping ${reason.mappingId}`}
                                </>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.attention ? (
                      <div className="notice warn" role="note" data-testid={`attention-${r.appId}`}>
                        Holds {r.roles.length === 1 ? "a role" : "roles"} here, but{" "}
                        {r.admission.kind === "unknown"
                          ? "whether they can sign in isn't known."
                          : "can't sign in to this app."}
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Actions">
                    <Link
                      href={`/admin/roles?${new URLSearchParams({ app: r.appId, subject })}`}
                      aria-label={`Manage ${title}'s roles in ${r.appName}`}
                      data-testid={`manage-${r.appId}`}
                    >
                      Manage roles
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="activity-h" data-testid="user-activity">
        <h3 id="activity-h">Recent activity</h3>
        {!activityResult.ok ? (
          <p className="muted" data-testid="activity-unavailable">
            The sign-in trail can&apos;t be read right now (it needs identity&apos;s own sign-in and an identity
            administrator). Everything else on this page still applies.
          </p>
        ) : activityResult.events.length === 0 ? (
          <p className="muted">Nothing recorded for this account yet.</p>
        ) : (
          <div className="table-wrap os-table-wrap">
            <table className="os-table os-table--stack">
              <caption>The latest {ACTIVITY} events</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {activityResult.events.map((e) => {
                  const o = outcome(e.event);
                  return (
                    <tr key={e.id}>
                      <td data-label="Time">{formatTime(e.at)}</td>
                      <td data-label="Event">
                        <code>{e.event}</code>
                        {e.method ? <span className="muted"> · {e.method}</span> : null}
                        {e.actorId && e.actorId !== subject ? (
                          <span className="muted"> · by {e.actorLabel ?? e.actorId}</span>
                        ) : null}
                      </td>
                      <td data-label="Outcome">
                        <span className={`badge ${o === "succeeded" ? "active" : o === "failed" ? "removed" : ""}`}>
                          {o}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p>
          <Link href={`/admin/audit/sign-ins?principal=${encodeURIComponent(subject)}`} data-testid="sign-in-history">
            View sign-in history
          </Link>
        </p>
      </section>

      <section aria-labelledby="actions-h" className="card" data-testid="user-actions">
        <h3 id="actions-h" style={{ marginTop: 0 }}>
          Actions
        </h3>
        <div className="row">
          <CopyButton value={subject} label="Copy account ID" />
          <Link className="button" href={`/admin/roles?${new URLSearchParams({ subject })}`} data-testid="manage-roles">
            Manage roles
          </Link>
          {person ? (
            <a className="button secondary" href={identityAdminUrl()} data-testid="identity-admin">
              Open identity administration
            </a>
          ) : null}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Suspending, reconnecting and approving access happen in identity administration; roles in Roles &amp; grants,
          which opens with this person already chosen.
        </p>
      </section>
    </>
  );
}
