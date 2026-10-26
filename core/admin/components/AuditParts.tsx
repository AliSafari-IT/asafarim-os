/**
 * The Audit pages' shared pieces: the tabs between the overview and the two trails, a tone badge (the tone is
 * in the text as well as the colour), and the activity chart, drawn as plain HTML bars that scale with the
 * page (no chart library, nothing in the browser), with the same numbers as a table for screen readers.
 */
import Link from "next/link";
import type { DayBuckets, Tone } from "@/lib/audit";

const TABS = [
  { href: "/admin/audit", label: "Overview", id: "overview" },
  { href: "/admin/audit/changes", label: "Admin changes", id: "changes" },
  { href: "/admin/audit/sign-ins", label: "Sign-ins & access", id: "sign-ins" },
] as const;

export function AuditTabs({ current }: { current: (typeof TABS)[number]["id"] }) {
  return (
    <nav aria-label="Audit" className="audit-tabs">
      <ul>
        {TABS.map((t) => (
          <li key={t.id}>
            <Link href={t.href} aria-current={t.id === current ? "page" : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const TONE_WORD: Record<Tone, string> = { good: "OK", info: "Info", warn: "Check", bad: "Alert" };

export function ToneBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`badge tone-${tone}`} title={TONE_WORD[tone]}>
      <span className="visually-hidden">{TONE_WORD[tone]}: </span>
      {label}
    </span>
  );
}

export const SERIES = [
  { key: "signins", label: "Sign-ins" },
  { key: "failures", label: "Failed or refused" },
  { key: "access", label: "Access & connections" },
  { key: "changes", label: "Admin changes" },
] as const satisfies readonly { key: keyof Omit<DayBuckets, "day">; label: string }[];

const shortDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
};

export function ActivityChart({ days, caption }: { days: DayBuckets[]; caption: string }) {
  const totals = days.map((d) => d.signins + d.failures + d.access + d.changes);
  const max = Math.max(1, ...totals);
  const sum = (k: (typeof SERIES)[number]["key"]) => days.reduce((n, d) => n + d[k], 0);
  const label = `${caption}: ${SERIES.map((s) => `${sum(s.key)} ${s.label.toLowerCase()}`).join(", ")}.`;
  return (
    <figure className="chart" data-testid="audit-chart">
      <figcaption>
        <strong>{caption}</strong>
        <ul className="legend">
          {SERIES.map((s) => (
            <li key={s.key}>
              <span className={`swatch s-${s.key}`} aria-hidden="true" />
              {s.label} <span className="muted">({sum(s.key)})</span>
            </li>
          ))}
        </ul>
      </figcaption>
      <div
        className={`bars${days.length > 16 ? " bars-dense" : ""}`}
        role="img"
        aria-label={label}
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
      >
        {days.map((d, i) => (
          <div
            className="bar-col"
            key={d.day}
            title={`${shortDay(d.day)}: ${SERIES.map((s) => `${d[s.key]} ${s.label.toLowerCase()}`).join(", ")}`}
          >
            <div className="bar" style={{ height: `${(totals[i]! / max) * 100}%` }}>
              {SERIES.map((s) =>
                d[s.key] ? <span key={s.key} className={`seg s-${s.key}`} style={{ flexGrow: d[s.key] }} /> : null,
              )}
            </div>
            <span className={`bar-day${i % 2 ? " odd" : ""}`}>{shortDay(d.day).split(" ")[0]}</span>
          </div>
        ))}
      </div>
      <details className="chart-table">
        <summary>Show the numbers</summary>
        <div className="os-table-wrap">
          <table className="os-table">
            <caption className="visually-hidden">{caption}, per day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {SERIES.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <th scope="row" className="os-nowrap">
                    {shortDay(d.day)}
                  </th>
                  {SERIES.map((s) => (
                    <td key={s.key}>{d[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** A count on the overview, with what it means underneath. */
export function Kpi({
  value,
  label,
  hint,
  tone,
  href,
}: {
  value: number | string;
  label: string;
  hint?: string;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
    </>
  );
  return (
    <li className={`kpi${tone ? ` tone-${tone}` : ""}`} data-testid="audit-kpi">
      {href ? <Link href={href}>{body}</Link> : body}
    </li>
  );
}

/** A list of counts with proportional bars (the busiest actions, the busiest actors). */
export function RankList({
  items,
  empty,
}: {
  items: { label: React.ReactNode; count: number; key: string }[];
  empty: string;
}) {
  if (!items.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.count));
  return (
    <ol className="rank">
      {items.map((i) => (
        <li key={i.key}>
          <span className="rank-label">{i.label}</span>
          <span className="rank-count">{i.count}</span>
          <span className="rank-bar" aria-hidden="true">
            <span style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Why the sign-in trail isn't shown. */
export function TrailUnavailable({
  state,
  identityAdminUrl,
}: {
  state: "not-admin" | "unavailable";
  identityAdminUrl: string;
}) {
  return state === "not-admin" ? (
    <p className="notice warn" data-testid="trail-not-admin">
      The sign-in trail is identity&apos;s, and identity shows it only to its own admins. Your account holds{" "}
      <code>core.admin</code> but isn&apos;t an identity admin. An identity admin can make you one at{" "}
      <a href={identityAdminUrl}>identity&apos;s admin page</a>.
    </p>
  ) : (
    <p className="notice" data-testid="trail-unavailable">
      The sign-in trail isn&apos;t available right now: identity didn&apos;t answer, or it runs without its own sign-in.
      Admin changes are still shown.
    </p>
  );
}
