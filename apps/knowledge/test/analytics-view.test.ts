// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightsView } from "../components/InsightsView";
import { pageLabel, shareLabel } from "../lib/analytics/labels";
import { RETENTION_DAYS, SEARCH_RETENTION_DAYS, windowOf, type Insights } from "../lib/analytics/store";

const w = windowOf(7, new Date("2026-11-27T10:00:00Z"));
const insights = (over: Partial<Insights> = {}): Insights => ({
  days: 7,
  from: w.from,
  to: w.to,
  totals: { views: 1234, shares: 5, feedFetches: 17 },
  daily: w.list.map((day, i) => ({ day, views: i === 3 ? 0 : (i + 1) * 100 })),
  articles: [
    {
      slug: "ai-apps",
      title: "Building AI-Powered Apps",
      published: true,
      views: 900,
      shares: { linkedin: 3, copy: 1 },
      shareTotal: 4,
    },
    { slug: "quiet", title: "A quiet article", published: true, views: 12, shares: {}, shareTotal: 0 },
  ],
  referrers: [{ label: "linkedin.com", count: 40 }],
  searches: [{ label: "react hooks", count: 5 }],
  pages: [
    { label: "home", count: 300 },
    { label: "topic:web", count: 20 },
  ],
  readers: [{ label: "Feedly", count: 17 }],
  shareTargets: [{ label: "linkedin", count: 3 }],
  ...over,
});
const render = (i: Insights, siteWide: boolean) =>
  new DOMParser().parseFromString(
    `<body>${renderToStaticMarkup(createElement(InsightsView, { insights: i, siteWide }))}</body>`,
    "text/html",
  );
const text = (d: Document, id: string) => d.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe("the Insights view", () => {
  it("shows an editor the totals, the chart, the articles and every site-wide table", () => {
    const d = render(insights(), true);
    expect(text(d, "insights-views")).toContain("1,234");
    expect(text(d, "insights-views")).toContain("Page views");
    expect(text(d, "insights-shares")).toContain("5");
    expect(text(d, "insights-feed")).toContain("17");
    expect(d.querySelectorAll('[data-testid="insights-article"]')).toHaveLength(2);
    expect(text(d, "insights-referrers")).toContain("linkedin.com");
    expect(text(d, "insights-pages")).toContain("Home page");
    expect(text(d, "insights-pages")).toContain("Topic: web");
    expect(text(d, "insights-searches")).toContain("react hooks");
    expect(text(d, "insights-share-targets")).toContain("LinkedIn");
    expect(text(d, "insights-readers")).toContain("Feedly");
    expect(d.body.textContent).not.toContain("You see the articles you own");
  });

  it("does not link a withdrawn article to its public page, which no longer exists", () => {
    const d = render(
      insights({ articles: [{ slug: "gone", title: "Gone", published: false, views: 3, shares: {}, shareTotal: 0 }] }),
      true,
    );
    const row = d.querySelector('[data-testid="insights-article"]')!;
    expect(row.querySelector("a")).toBeNull();
    expect(row.textContent).toContain("Gone");
    expect(row.textContent).toContain("withdrawn");
  });

  it("shows an author their articles only: no site-wide table, no feed card, and says so", () => {
    const d = render(
      insights({
        referrers: null,
        searches: null,
        pages: null,
        readers: null,
        shareTargets: null,
        totals: { views: 912, shares: 4, feedFetches: null },
      }),
      false,
    );
    expect(text(d, "insights-views")).toContain("Article views");
    expect(d.querySelector('[data-testid="insights-feed"]')).toBeNull();
    for (const id of [
      "insights-referrers",
      "insights-pages",
      "insights-searches",
      "insights-share-targets",
      "insights-readers",
    ]) {
      expect(d.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
    expect(d.body.textContent).toContain("You see the articles you own");
    expect(d.querySelectorAll('[data-testid="insights-article"]')).toHaveLength(2);
  });

  it("lists shares per button, and a plain 0 when an article was not shared", () => {
    const d = render(insights(), true);
    const [first, second] = [...d.querySelectorAll('[data-testid="insights-article"]')];
    expect(first!.textContent).toContain("4 (LinkedIn 3, Copy link 1)");
    expect(second!.textContent).toContain("0");
    expect(first!.querySelector("a")!.getAttribute("href")).toBe("/articles/ai-apps");
  });

  it("draws one bar a day in an accessible chart, with the numbers behind it", () => {
    const d = render(insights(), true);
    const svg = d.querySelector("svg.chart")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toMatch(/Views per day from 2026-11-21 to 2026-11-27: 2,?\d{3} in total/);
    const bars = [...svg.querySelectorAll("rect")];
    expect(bars).toHaveLength(7);
    expect(bars[3]!.getAttribute("height")).toBe("0"); // a day with no views is no bar
    expect(Number(bars[6]!.getAttribute("height"))).toBeGreaterThan(Number(bars[0]!.getAttribute("height")));
    expect(bars[0]!.querySelector("title")!.textContent).toBe("2026-11-21: 100 views");
    expect(d.querySelectorAll(".chart-numbers tbody tr")).toHaveLength(7);
    expect(d.querySelector(".chart-numbers tbody tr td")!.textContent).toBe("2026-11-27"); // newest first
  });

  it("says so, and draws nothing, when nobody has read anything", () => {
    const empty = insights({
      totals: { views: 0, shares: 0, feedFetches: 0 },
      daily: w.list.map((day) => ({ day, views: 0 })),
      articles: [],
      referrers: [],
      searches: [],
      pages: [],
      readers: [],
      shareTargets: [],
    });
    const d = render(empty, true);
    expect(text(d, "insights-no-articles")).toContain("No article has been read");
    expect([...d.querySelectorAll("svg.chart rect")].every((r) => r.getAttribute("height") === "0")).toBe(true);
    expect(text(d, "insights-views")).toContain("0");
  });

  it("marks the chosen period, and links the others", () => {
    const d = render(insights({ days: 30 }), true);
    expect(d.querySelector('[data-testid="period-30"]')!.getAttribute("aria-current")).toBe("page");
    expect(d.querySelector('[data-testid="period-7"]')!.getAttribute("aria-current")).toBeNull();
    expect(d.querySelector('[data-testid="period-90"]')!.getAttribute("href")).toBe("/studio/insights?days=90");
  });

  it("states what is and isn't kept, with the real retention numbers", () => {
    const note = text(render(insights(), true), "insights-note")!;
    expect(note).toContain("no cookies");
    expect(note).toContain("no IP addresses");
    expect(note).toContain("Do Not Track");
    expect(note).toContain(`${SEARCH_RETENTION_DAYS} days`);
    expect(note).toContain(`every other total for ${RETENTION_DAYS} days`);
  });

  it("keeps a hostile article title or search term as text, never as markup", () => {
    const bad = `<img src=x onerror=alert(1)><script>alert(2)</script>`;
    const d = render(
      insights({
        articles: [{ slug: "x", title: bad, published: true, views: 1, shares: {}, shareTotal: 0 }],
        searches: [{ label: bad, count: 9 }],
      }),
      true,
    );
    expect(d.querySelector("script")).toBeNull();
    expect(d.querySelector("img")).toBeNull();
    expect(d.body.textContent).toContain(bad);
  });
});

describe("labels", () => {
  it("turns page keys into words and leaves unknown ones alone", () => {
    expect(pageLabel("home")).toBe("Home page");
    expect(pageLabel("courses")).toBe("Courses list");
    expect(pageLabel("search")).toBe("Search");
    expect(pageLabel("topic:web")).toBe("Topic: web");
    expect(pageLabel("course:ship-it")).toBe("Course: ship-it");
    expect(pageLabel("lesson:ship-it")).toBe("Lessons of ship-it");
    expect(pageLabel("article:ai")).toBe("Article: ai");
    expect(pageLabel("weird:key")).toBe("weird:key");
    expect(pageLabel("plain")).toBe("plain");
  });

  it("names the share buttons", () => {
    expect(shareLabel("linkedin")).toBe("LinkedIn");
    expect(shareLabel("x")).toBe("X");
    expect(shareLabel("copy")).toBe("Copy link");
    expect(shareLabel("other")).toBe("other");
  });
});
