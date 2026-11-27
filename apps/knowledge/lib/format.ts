/** "27 Nov 2026": a publication date the same for every reader, whatever their time zone. */
const PUBLISHED = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const formatPublished = (d: Date): string => PUBLISHED.format(d);
