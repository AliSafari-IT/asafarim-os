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
    const update = () => {
      const line = window.innerHeight * 0.2;
      let current = targets[0]!.id;
      for (const el of targets) if (el.getBoundingClientRect().top <= line) current = el.id;
      setActive(current);
    };
    const observer = new IntersectionObserver(update, { rootMargin: "0px 0px -80% 0px", threshold: [0, 1] });
    targets.forEach((el) => observer.observe(el));
    window.addEventListener("hashchange", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", update);
    };
  }, [items]);

  if (!items.length) return <p className="muted">This document has no sections.</p>;
  return (
    <ol data-testid="toc">
      {items.map((h) => (
        <li key={h.id} className={`level-${h.level}`}>
          <a href={`#${h.id}`} aria-current={h.id === active ? "location" : undefined}>
            {h.text}
          </a>
        </li>
      ))}
    </ol>
  );
}
