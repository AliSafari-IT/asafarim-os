/**
 * What the Insights page shows: a number or two, a bar for each day, the articles people read and share, and, for an
 * editor, where readers came from and what they searched. Presentational (no data fetching, no state), so it renders
 * the same from a test as from the page. Every figure is a daily total from lib/analytics/store.ts: nothing here
 * refers to a person.
 */
import Link from "next/link";
import { pageLabel, shareLabel } from "@/lib/analytics/labels";
import {
  MIN_SEARCH_COUNT,
  PERIODS,
  RETENTION_DAYS,
  SEARCH_RETENTION_DAYS,
  type Counted,
  type Insights,
} from "@/lib/analytics/store";

const nf = new Intl.NumberFormat("en-GB");

function ViewsChart({ daily, from, to }: { daily: Insights["daily"]; from: string; to: string }) {
  const W = 600;
  const H = 140;
  const max = Math.max(1, ...daily.map((d) => d.views));
  const total = daily.reduce((t, d) => t + d.views, 0);
  const barW = W / Math.max(1, daily.length);
  return (
    <figure className="chart-figure" data-testid="insights-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Views per day from ${from} to ${to}: ${nf.format(total)} in total, at most ${nf.format(max)} in a day`}
        className="chart"
      >
        {daily.map((d, i) => {
          const h = d.views === 0 ? 0 : Math.max(2, (d.views / max) * (H - 6));
          return (
            <rect
              key={d.day}
              className="chart-bar"
              x={i * barW + 0.5}
              y={H - h}
              width={Math.max(barW - 1, 1)}
              height={h}
            >
              <title>{`${d.day}: ${nf.format(d.views)} ${d.views === 1 ? "view" : "views"}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="chart-axis">
        <span>{from}</span>
        <span>busiest day: {nf.format(max === 1 && total === 0 ? 0 : max)}</span>
        <span>{to}</span>
      </figcaption>
      <details className="chart-numbers">
        <summary>Show the numbers</summary>
        <table className="studio-list">
          <thead>
            <tr>
              <th scope="col">Day (UTC)</th>
              <th scope="col">Views</th>
            </tr>
          </thead>
          <tbody>
            {[...daily].reverse().map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{nf.format(d.views)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function CountTable({
  title,
  head,
  rows,
  empty,
  note,
  testId,
  label = (s: string) => s,
}: {
  title: string;
  head: string;
  rows: Counted[];
  empty: string;
  note?: string;
  testId: string;
  label?: (s: string) => string;
}) {
  return (
    <section className="card" data-testid={testId}>
      <h2>{title}</h2>
      {note ? <p className="muted">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <table className="studio-list">
          <thead>
            <tr>
              <th scope="col">{head}</th>
              <th scope="col">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{label(r.label)}</td>
                <td>{nf.format(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function InsightsView({ insights, siteWide }: { insights: Insights; siteWide: boolean }) {
  const { totals } = insights;
  return (
    <div data-testid="insights">
      <nav className="period" aria-label="Period">
        {PERIODS.map((d) => (
          <Link
            key={d}
            href={`/studio/insights?days=${d}`}
            aria-current={d === insights.days ? "page" : undefined}
            data-testid={`period-${d}`}
          >
            Last {d} days
          </Link>
        ))}
      </nav>
      {!siteWide ? <p className="muted">You see the articles you own. Editors see the whole site.</p> : null}

      <div className="insights-grid">
        <div className="card stat" data-testid="insights-views">
          <span className="stat-value">{nf.format(totals.views)}</span>
          <span className="stat-label">{siteWide ? "Page views" : "Article views"}</span>
        </div>
        <div className="card stat" data-testid="insights-shares">
          <span className="stat-value">{nf.format(totals.shares)}</span>
          <span className="stat-label">Share clicks</span>
        </div>
        {totals.feedFetches !== null ? (
          <div className="card stat" data-testid="insights-feed">
            <span className="stat-value">{nf.format(totals.feedFetches)}</span>
            <span className="stat-label">RSS feed fetches</span>
          </div>
        ) : null}
      </div>

      <section className="card">
        <h2>Views per day</h2>
        <ViewsChart daily={insights.daily} from={insights.from} to={insights.to} />
      </section>

      <section className="card" data-testid="insights-articles">
        <h2>Articles</h2>
        {insights.articles.length === 0 ? (
          <p className="muted" data-testid="insights-no-articles">
            No article has been read in this period yet.
          </p>
        ) : (
          <table className="studio-list">
            <thead>
              <tr>
                <th scope="col">Article</th>
                <th scope="col">Views</th>
                <th scope="col">Shares</th>
              </tr>
            </thead>
            <tbody>
              {insights.articles.map((a) => (
                <tr key={a.slug} data-testid="insights-article">
                  <td>
                    <Link href={`/articles/${a.slug}`}>{a.title}</Link>
                  </td>
                  <td>{nf.format(a.views)}</td>
                  <td>
                    {a.shareTotal === 0 ? (
                      <span className="muted">0</span>
                    ) : (
                      <>
                        {nf.format(a.shareTotal)}{" "}
                        <span className="muted">
                          (
                          {Object.entries(a.shares)
                            .map(([t, n]) => `${shareLabel(t)} ${n}`)
                            .join(", ")}
                          )
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {siteWide ? (
        <div className="insights-cols">
          <CountTable
            testId="insights-referrers"
            title="Where readers came from"
            head="Site"
            rows={insights.referrers ?? []}
            empty="No referring sites yet. Direct visits and this site's own pages aren't listed."
          />
          <CountTable
            testId="insights-pages"
            title="Other pages"
            head="Page"
            rows={insights.pages ?? []}
            empty="Nothing yet."
            label={pageLabel}
          />
          <CountTable
            testId="insights-searches"
            title="What people searched for"
            head="Search"
            rows={insights.searches ?? []}
            empty="Nothing searched often enough to show."
            note={`A term is shown once it was searched at least ${MIN_SEARCH_COUNT} times, never tied to a person.`}
          />
          <CountTable
            testId="insights-share-targets"
            title="Share buttons"
            head="Button"
            rows={insights.shareTargets ?? []}
            empty="No share clicks yet."
            label={shareLabel}
          />
          <CountTable
            testId="insights-readers"
            title="RSS readers"
            head="Reader"
            rows={insights.readers ?? []}
            empty="Nobody has fetched the feed in this period."
          />
        </div>
      ) : null}

      <p className="muted insights-note" data-testid="insights-note">
        These are anonymous daily totals: no cookies, no IP addresses and no visitor identifiers are kept, and nothing
        is counted for bots, prefetches, or browsers that send Do Not Track or Global Privacy Control. Days are UTC.
        Search terms are kept for {SEARCH_RETENTION_DAYS} days and every other total for {RETENTION_DAYS} days.
      </p>
    </div>
  );
}
