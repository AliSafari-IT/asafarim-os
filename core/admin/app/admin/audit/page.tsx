import Link from "next/link";
import { redirect } from "next/navigation";
import { When } from "@/components/Cells";
import { ActivityChart, AuditTabs, Kpi, RankList, ToneBadge, TrailUnavailable } from "@/components/AuditParts";
import {
  actorName,
  attention,
  describeChange,
  describeSignIn,
  isSensitiveChange,
  signInSeries,
  withChanges,
  type Tone,
} from "@/lib/audit";
import { coreApi } from "@/lib/core-api";
import { identityAdminUrl, identityApi, trailState, type TrailState } from "@/lib/identity-api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit · Admin · ASafariM OS" };

const PERIODS = [7, 14, 30] as const;

/** The guide to the trails (asafarim-docs, read in the Docs app). */
const GUIDE =
  process.env.ADMIN_AUDIT_GUIDE_URL ??
  "https://docs.asafarim.site/?doc=ventures%2Fasafarim-os%2Foperations%2Fadmin-audits.md";

export default async function AuditOverview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  // The Audit page used to be the admin-changes list: keep its old filtered links working.
  if (params.app || params.actor || params.before)
    redirect(`/admin/audit/changes?${new URLSearchParams(params as Record<string, string>)}`);
  const days = PERIODS.find((p) => String(p) === params.days) ?? 14;
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  const api = coreApi(admin.idToken);
  const ids = identityApi(admin.idToken);
  const [changes, recentChanges, sensitive, signIns, recentSignIns] = await Promise.all([
    api.auditSummary(days),
    api.audit({ limit: 8 }),
    // Platform-admin grants and removals in the period: few, and each worth a look.
    Promise.all([api.audit({ action: "role.", since, limit: 100 }), api.audit({ action: "app.", since, limit: 100 })]),
    ids.summary(days).catch((err: unknown) => trailState(err)),
    ids.audit({ limit: 8 }).catch(() => null),
  ]);
  const trail: TrailState = typeof signIns === "string" ? signIns : "ok";
  const signInSummary = typeof signIns === "string" ? null : signIns;

  const series = withChanges(
    signInSeries(signInSummary?.byDay ?? changes.byDay.map((d) => ({ day: d.day, events: {} }))),
    changes.byDay,
  );
  const sum = (k: "signins" | "failures" | "access" | "changes") => series.reduce((n, d) => n + d[k], 0);
  const sensitiveChanges = sensitive.flatMap((s) => s.events).filter(isSensitiveChange);
  const deniedAdmin = signInSummary?.byEvent["admin.denied"] ?? 0;
  const items = attention({
    pendingRequests: signInSummary?.pendingRequests ?? 0,
    days: series,
    deniedAdmin,
    sensitiveChanges,
    identityAdminUrl: identityAdminUrl(),
  });

  // The newest of both trails, merged on time.
  const recent: { at: string; key: string; who: string; tone: Tone; label: string; sentence: string; href: string }[] =
    [
      ...recentChanges.events.map((e) => {
        const d = describeChange(e);
        return {
          at: e.at,
          key: `c${e.id}`,
          who: actorName(e.actor),
          tone: d.tone,
          label: d.label,
          sentence: d.sentence,
          href: `/admin/audit/changes?action=${e.action}`,
        };
      }),
      ...(recentSignIns?.events ?? []).map((e) => {
        const d = describeSignIn(e);
        return {
          at: e.at,
          key: `s${e.id}`,
          who: e.label ?? (e.principalId ? e.principalId.slice(0, 8) : "someone not yet known"),
          tone: d.tone,
          label: d.label,
          sentence: d.sentence,
          href: e.principalId ? `/admin/audit/sign-ins?principal=${e.principalId}` : "/admin/audit/sign-ins",
        };
      }),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10);

  return (
    <>
      <h2>Audit</h2>
      <p className="muted">
        What happened on the platform: who signed in, who asked for access, and every change an administrator made.
        Times are UTC. <a href={GUIDE}>How auditing works</a>
      </p>
      <AuditTabs current="overview" />

      <nav aria-label="Period" className="period">
        <span className="muted">Last</span>
        <ul className="seg-control">
          {PERIODS.map((p) => (
            <li key={p}>
              <Link href={`/admin/audit?days=${p}`} aria-current={p === days ? "true" : undefined}>
                {p} days
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <ul className="kpis" aria-label={`The last ${days} days`}>
        <Kpi
          value={signInSummary ? sum("signins") : "—"}
          label="Sign-ins"
          hint="completed, into any app"
          tone="good"
          href="/admin/audit/sign-ins?kind=signins"
        />
        <Kpi
          value={signInSummary ? sum("failures") : "—"}
          label="Failed or refused"
          hint="wrong codes, no access, refused admin"
          tone={sum("failures") ? "warn" : undefined}
          href="/admin/audit/sign-ins?kind=failures"
        />
        <Kpi
          value={signInSummary ? signInSummary.pendingRequests : "—"}
          label="Waiting for access"
          hint="signed in, an admin must approve"
          tone={signInSummary?.pendingRequests ? "warn" : undefined}
          href="/admin/audit/sign-ins?kind=access"
        />
        <Kpi
          value={signInSummary ? signInSummary.activeConnections : "—"}
          label="People with access"
          hint="active connections now"
        />
        <Kpi value={changes.total} label="Admin changes" hint="apps, roles, schemas" href="/admin/audit/changes" />
      </ul>

      {trail !== "ok" ? <TrailUnavailable state={trail} identityAdminUrl={identityAdminUrl()} /> : null}

      <section aria-labelledby="attention" className="card">
        <h3 id="attention" className="card-title">
          Needs attention
        </h3>
        {items.length === 0 ? (
          <p className="muted" data-testid="attention-none">
            Nothing unusual in the last {days} days.
          </p>
        ) : (
          <ul className="attention" data-testid="attention">
            {items.map((a, i) => (
              <li key={i} className={`tone-${a.tone}`}>
                <span>{a.text}</span>
                {a.href ? (
                  <a href={a.href} className="os-nowrap">
                    {a.link} →
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <ActivityChart days={series} caption={`Activity, last ${days} days`} />
      </section>

      <div className="split">
        <section aria-labelledby="recent" className="card">
          <h3 id="recent" className="card-title">
            Latest events
          </h3>
          {recent.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ol className="timeline" data-testid="audit-timeline">
              {recent.map((r) => (
                <li key={r.key}>
                  <div className="timeline-head">
                    <ToneBadge tone={r.tone} label={r.label} />
                    <When iso={r.at} />
                  </div>
                  <p>
                    <a href={r.href}>{r.sentence}</a>{" "}
                    <span className="muted who-link" title={r.who}>
                      · {r.who}
                    </span>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="busiest" className="card">
          <h3 id="busiest" className="card-title">
            Busiest admin actions
          </h3>
          <RankList
            empty="No admin changes in this period."
            items={changes.byAction.slice(0, 6).map((a) => ({
              key: a.action,
              count: a.count,
              label: (
                <a href={`/admin/audit/changes?action=${a.action}`} className="mono">
                  {a.action}
                </a>
              ),
            }))}
          />
          <h3 className="card-title">Who made them</h3>
          <RankList
            empty="Nobody."
            items={changes.topActors.slice(0, 6).map((a) => ({
              key: a.actor,
              count: a.count,
              label: (
                <a href={`/admin/audit/changes?actor=${encodeURIComponent(a.actor)}`} className="os-id" title={a.actor}>
                  {actorName(a.actor)}
                </a>
              ),
            }))}
          />
        </section>
      </div>
    </>
  );
}
