/**
 * Insights: anonymous daily totals for the site (lib/analytics). An editor sees everything; an author sees the
 * articles they own. The studio gate (and the gateway) already require knowledge.content.create for /studio/**.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { InsightsView } from "@/components/InsightsView";
import { Notices } from "@/components/Notices";
import { StudioTabs } from "@/components/StudioTabs";
import { TopBar } from "@/components/TopBar";
import { getInsights, parsePeriod } from "@/lib/analytics/store";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { seesAll } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Insights", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<SearchParams> };

export default async function InsightsPage({ searchParams }: Props) {
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio/insights" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const days = parsePeriod(one((await searchParams).days));
  const siteWide = seesAll(g.actor);
  let insights;
  try {
    insights = await getInsights(await db(), { subject: g.actor.subject, all: siteWide }, days);
  } catch {
    insights = null;
  }
  return (
    <>
      <TopBar next="/studio/insights" />
      <main className="wide">
        <p>
          <Link href="/studio">← Studio</Link>
        </p>
        <h1>Insights</h1>
        <StudioTabs actor={g.actor} current="insights" />
        {insights ? (
          <InsightsView insights={insights} siteWide={siteWide} />
        ) : (
          <div className="notice bad" role="alert" data-testid="insights-unavailable">
            The numbers can&apos;t be loaded right now. Try again in a moment.
          </div>
        )}
      </main>
    </>
  );
}
