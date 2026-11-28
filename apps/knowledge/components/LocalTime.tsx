"use client";
/** A moment in the reader's own time zone (the server only knows UTC); until hydrated, the UTC text. */
import { useEffect, useState } from "react";

export function LocalTime({ iso, withTime = true }: { iso: string; withTime?: boolean }) {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "numeric" };
  const [text, setText] = useState(
    () => d.toLocaleString("en-GB", { ...opts, timeZone: "UTC" }) + (withTime ? " UTC" : ""),
  );
  useEffect(() => setText(d.toLocaleString(undefined, opts)), [iso]);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
