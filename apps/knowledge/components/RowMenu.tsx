"use client";
/**
 * The "⋯" menu at the end of a studio list row: a native disclosure (<details>) that also closes on an outside
 * click or Escape. It only links to routes that already exist; it carries no action of its own.
 */
import Link from "next/link";
import { useEffect, useRef } from "react";

export interface RowMenuLink {
  href: string;
  label: string;
  /** Draws the link as a destructive one. */
  danger?: boolean;
}

export function RowMenu({ title, links }: { title: string; links: RowMenuLink[] }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== "Escape" || !el?.open) return;
      el.open = false;
      el.querySelector("summary")?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details className="row-menu" ref={ref} data-testid="row-menu">
      <summary aria-label={`Actions for ${title}`}>
        <span aria-hidden="true">⋯</span>
      </summary>
      <ul onClick={() => ref.current?.removeAttribute("open")}>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={l.danger ? "danger" : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
