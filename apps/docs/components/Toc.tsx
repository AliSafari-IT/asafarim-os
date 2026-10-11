"use client";
/**
 * "On this page" (#80): the document's h2 and h3 headings, with the section you're reading marked
 * (aria-current="location") as you scroll.
 */
import { useEffect, useState } from "react";

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id);

  useEffect(() => {
    const targets = items.map((h) => document.getElementById(h.id)).filter((el): el is HTMLElement => el !== null);
    if (!targets.length) return;
    // The current section is the last heading that has scrolled past the top fifth of the window.
    // Positions are read on scroll (once per frame), so late layout shifts such as an image loading
    // are picked up too.
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.2;
      let current = targets[0]!.id;
      for (const el of targets) if (el.getBoundingClientRect().top <= line) current = el.id;
      // At the bottom of the page the last sections can't reach the top: the one linked to wins.
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      const linked = decodeURIComponent(window.location.hash.slice(1));
      if (atBottom && targets.some((el) => el.id === linked)) current = linked;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("hashchange", onScroll);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("hashchange", onScroll);
    };
  }, [items]);

  if (!items.length) return <p className="muted">This document has no sections.</p>;
  return (
    <ol data-testid="toc">
      {items.map((h) => (
        <li key={h.id} className={`level-${h.level}`}>
          <a
            href={`#${h.id}`}
            aria-current={h.id === active ? "location" : undefined}
            // The section you picked is the current one, even when the page can't scroll it to the top.
            onClick={() => setActive(h.id)}
          >
            {h.text}
          </a>
        </li>
      ))}
    </ol>
  );
}
