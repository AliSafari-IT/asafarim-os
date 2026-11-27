/**
 * What counts, and how a raw request becomes a safe, small label. Pure (no framework, no database, nothing from
 * Knowledge), so the same rules can serve every app. The privacy line is drawn here: a view is counted only for a
 * real person's page load, never for a bot or a prefetch, never when the browser says Do Not Track or Global Privacy
 * Control; and what is kept of a request is a label (a referring site's name, a reader's name, a cleaned search
 * term), never an address, a browser string or an identifier.
 */

export type HeaderBag = Pick<Headers, "get">;

export type AnalyticsKind = "view" | "share" | "feed" | "search";

export const SHARE_TARGETS = ["linkedin", "x", "email", "copy"] as const;
export type ShareTarget = (typeof SHARE_TARGETS)[number];
export const isShareTarget = (v: unknown): v is ShareTarget => SHARE_TARGETS.includes(v as ShareTarget);

// Crawlers, monitors, link-preview fetchers, scripts and headless browsers: not people reading.
const BOT =
  /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|fetcher|monitor|uptime|pingdom|lighthouse|headless|phantom|puppeteer|playwright|selenium|curl|wget|httpie|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|httpclient/i;

export const looksLikeBot = (userAgent: string | null): boolean => !userAgent || BOT.test(userAgent);

/** The browser asked not to be measured: Global Privacy Control or Do Not Track. Honoured though no personal data is kept. */
export function optedOut(h: HeaderBag): boolean {
  return h.get("sec-gpc") === "1" || h.get("dnt") === "1";
}

/**
 * Is this request a person viewing a page? A full page load (Sec-Fetch-Dest: document), or the app's own client
 * fetching the next page after a click: a same-origin fetch (dest "empty", mode "cors", site "same-origin"). Next.js
 * strips its own RSC and prefetch headers before page code can read them, so the fetch metadata the BROWSER sends is
 * what identifies that case. Not a prefetch or prerender where the headers say so, not an image or an iframe, not a
 * bot, not an opted-out browser. A browser too old to send fetch metadata counts only if it says it is one.
 */
export function shouldCountView(h: HeaderBag): boolean {
  if (optedOut(h)) return false;
  const purpose = `${h.get("purpose") ?? ""} ${h.get("sec-purpose") ?? ""}`;
  if (h.get("next-router-prefetch") || /prefetch|prerender/i.test(purpose)) return false;
  const ua = h.get("user-agent");
  if (looksLikeBot(ua)) return false;
  const dest = h.get("sec-fetch-dest");
  if (dest) {
    if (dest === "document") return true;
    // The app's own client navigating (Next hides its RSC header from page code; the browser's metadata remains).
    return (
      dest === "empty" &&
      (Boolean(h.get("rsc")) || (h.get("sec-fetch-mode") === "cors" && h.get("sec-fetch-site") === "same-origin"))
    );
  }
  return /^Mozilla\//.test(ua ?? "");
}

const REFERRER_ALIASES: Record<string, string> = {
  "t.co": "x.com",
  "twitter.com": "x.com",
  "lnkd.in": "linkedin.com",
  "l.facebook.com": "facebook.com",
  "lm.facebook.com": "facebook.com",
  "m.facebook.com": "facebook.com",
  "out.reddit.com": "reddit.com",
  "old.reddit.com": "reddit.com",
  "android.googlesource.com": "google.com",
};

/**
 * The name of the site a visitor came from, or "" (direct, unknown, or this app's own pages). Only a host name: never
 * a path, a query or anything after it, which is where a person's search or session would be.
 */
export function refererSource(referer: string | null, ownHosts: readonly string[]): string {
  if (!referer) return "";
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  let host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!host.includes(".") || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return ""; // localhost, IPv6, IPv4
  if (ownHosts.some((own) => own.toLowerCase().replace(/^www\./, "") === host)) return "";
  if (/^google\.[a-z.]+$/.test(host)) host = "google.com"; // google.be, google.co.uk, ...
  host = REFERRER_ALIASES[host] ?? host;
  return host.slice(0, 100);
}

/**
 * A search term fit to count, or null. Search text is typed by a person and can hold personal details, so anything that
 * looks like an email, an address, a web address or a run of digits (a phone, card or id number) is dropped, as is
 * anything very short or long. What remains is lower-cased and tidied; the Insights page also shows a term only once
 * enough people searched it.
 */
export function cleanSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (term.length < 2 || term.length > 60) return null;
  if (/\p{Cc}/u.test(term)) return null;
  if (/@|https?:|:\/\/|www\./.test(term)) return null;
  if (/\d{6,}/.test(term.replace(/[\s.\-()]/g, ""))) return null;
  return term;
}

const READERS: [RegExp, string][] = [
  [/feedly/i, "Feedly"],
  [/inoreader/i, "Inoreader"],
  [/newsblur/i, "NewsBlur"],
  [/feedbin/i, "Feedbin"],
  [/netnewswire/i, "NetNewsWire"],
  [/reeder/i, "Reeder"],
  [/miniflux/i, "Miniflux"],
  [/freshrss/i, "FreshRSS"],
  [/tiny tiny rss|tt-rss/i, "Tiny Tiny RSS"],
  [/thunderbird/i, "Thunderbird"],
  [/akregator/i, "Akregator"],
  [/liferea/i, "Liferea"],
  [/flipboard/i, "Flipboard"],
  [/slackbot/i, "Slack"],
];

/**
 * Which feed reader fetched the feed, from a short allow-list of well-known ones. The raw browser string is never
 * kept (it can be nearly unique to one person); a reader not on the list is "Other", a person opening the feed in a
 * browser is "Browser", and a crawler or script is null: not counted.
 */
export function readerName(userAgent: string | null): string | null {
  const ua = userAgent ?? "";
  for (const [re, name] of READERS) if (re.test(ua)) return name;
  if (looksLikeBot(ua)) return null;
  return /^Mozilla\//.test(ua) ? "Browser" : "Other";
}

/** The label under which a page's views are counted. The only place these are built, so they stay consistent. */
export const viewKey = {
  home: "home",
  courses: "courses",
  search: "search",
  article: (slug: string) => `article:${slug}`,
  topic: (slug: string) => `topic:${slug}`,
  course: (slug: string) => `course:${slug}`,
  /** Views of a course's lessons, by course, not by lesson: how much a course is read, without one row per lesson. */
  lesson: (courseSlug: string) => `lesson:${courseSlug}`,
} as const;
