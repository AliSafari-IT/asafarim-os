import Link from "next/link";
import { JsonDetail, When } from "@/components/Cells";
import { AuditTabs, ToneBadge, TrailUnavailable } from "@/components/AuditParts";
import { METHODS, SIGN_IN_KINDS, dayAfter, describeSignIn, methodLabel } from "@/lib/audit";
import { signInFilters, signInQuery } from "@/lib/audit-filters";
import { identityAdminUrl, identityApi, trailState, type SignInEvent } from "@/lib/identity-api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign-ins & access · Audit · Admin · ASafariM OS" };

const PAGE = 25;

export default async function SignInsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const f = signInFilters(await searchParams);
  const kind = SIGN_IN_KINDS.find((k) => k.value === f.kind);
  let page: { events: SignInEvent[]; next: number | null } | null = null;
  let state: "not-admin" | "unavailable" | null = null;
  try {
    page = await identityApi(admin.idToken).audit({
      ...(kind ? { events: kind.events } : {}),
      ...(f.method ? { method: f.method } : {}),
      ...(f.principal ? { principal: f.principal } : {}),
      ...(f.handle ? { handle: f.handle } : {}),
      ...(f.from ? { since: f.from } : {}),
      ...(f.to ? { until: dayAfter(f.to) } : {}),
      ...(f.before ? { before: f.before } : {}),
      limit: PAGE,
    });
  } catch (err) {
    state = trailState(err);
  }
  const filtered = Boolean(f.kind || f.method || f.principal || f.handle || f.from || f.to);
  const person = f.principal && page?.events.find((e) => e.principalId === f.principal)?.label;

  return (
    <>
      <h2>Audit</h2>
      <p className="muted">
        Identity&apos;s trail: every sign-in, failed attempt, access request and decision, newest first. Signing in
        doesn&apos;t give access: someone without it is offered to request it, and an identity admin approves it at{" "}
        <a href={identityAdminUrl()}>identity&apos;s admin page</a>. Codes, numbers and addresses are never stored: an{" "}
        <em>address</em> below is a fingerprint, the same for every attempt from one place. Times are UTC.
      </p>
      <AuditTabs current="sign-ins" />

      <form method="get" className="card filters" aria-label="Filter sign-ins and access">
        <div>
          <label htmlFor="si-kind">What</label>
          <select id="si-kind" name="kind" defaultValue={f.kind ?? ""}>
            <option value="">Everything</option>
            {SIGN_IN_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="si-method">Method</label>
          <select id="si-method" name="method" defaultValue={f.method ?? ""}>
            <option value="">Any</option>
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="si-from">From</label>
          <input id="si-from" name="from" type="date" defaultValue={f.from ?? ""} />
        </div>
        <div>
          <label htmlFor="si-to">To</label>
          <input id="si-to" name="to" type="date" defaultValue={f.to ?? ""} />
        </div>
        {f.principal ? <input type="hidden" name="principal" value={f.principal} /> : null}
        {f.handle ? <input type="hidden" name="handle" value={f.handle} /> : null}
        <div className="filter-actions">
          <button type="submit">Filter</button>
          {filtered ? (
            <Link href="/admin/audit/sign-ins" className="muted">
              Clear
            </Link>
          ) : null}
          {page ? (
            <a href={`/admin/audit/export?source=sign-ins&${signInQuery(f)}`} download data-testid="export-sign-ins">
              Export CSV
            </a>
          ) : null}
        </div>
      </form>

      {f.principal || f.handle ? (
        <p className="notice" data-testid="si-scope">
          {f.principal ? (
            <>
              Only <strong>{person ?? f.principal}</strong>: what they did, and what was done to their access.{" "}
            </>
          ) : (
            <>
              Only attempts from one address (<code>{f.handle!.slice(0, 10)}…</code>) or on one identifier.{" "}
            </>
          )}
          <Link href={`/admin/audit/sign-ins?${signInQuery({ ...f, principal: undefined, handle: undefined })}`}>
            Show everyone
          </Link>
        </p>
      ) : null}

      {state ? (
        <TrailUnavailable state={state} identityAdminUrl={identityAdminUrl()} />
      ) : page && page.events.length === 0 ? (
        <p className="muted" data-testid="si-empty">
          No events match.
        </p>
      ) : page ? (
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack">
            <caption>
              {page.events.length} event{page.events.length === 1 ? "" : "s"}
              {kind ? `: ${kind.label.toLowerCase()}` : ""}
              {f.method ? `, ${methodLabel(f.method).toLowerCase()}` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What happened</th>
                <th scope="col">Method</th>
                <th scope="col">Address</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {page.events.map((e) => {
                const d = describeSignIn(e);
                return (
                  <tr key={e.id} data-testid="si-row">
                    <td data-label="When">
                      <When iso={e.at} />
                    </td>
                    <td data-label="Who">
                      {e.principalId ? (
                        <Link
                          href={`/admin/audit/sign-ins?principal=${e.principalId}`}
                          title={`Everything about ${e.principalId}`}
                          className="who-link"
                          data-testid="si-who"
                        >
                          {e.label ?? e.principalId}
                        </Link>
                      ) : (
                        <span className="muted">not proved yet</span>
                      )}
                    </td>
                    <td className="os-fill" data-label="What happened">
                      <ToneBadge tone={d.tone} label={d.label} /> {d.sentence}
                    </td>
                    <td className="os-nowrap" data-label="Method">
                      {methodLabel(e.method)}
                    </td>
                    <td data-label="Address">
                      {e.ipHandle ? (
                        <Link
                          href={`/admin/audit/sign-ins?handle=${e.ipHandle}`}
                          className="mono os-nowrap"
                          title="Every attempt from this address"
                        >
                          {e.ipHandle.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="Detail">
                      <JsonDetail value={e.detail} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {page?.next ? (
        <p>
          <Link href={`/admin/audit/sign-ins?${signInQuery(f, { before: String(page.next) })}`} rel="next">
            Older events
          </Link>
        </p>
      ) : null}
    </>
  );
}
