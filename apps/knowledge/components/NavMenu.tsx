"use client";
/**
 * The top bar's links on a phone: one "Menu" button that opens Courses, Assessments, Search and (for authors)
 * Studio, so the account controls still fit beside them. A native disclosure that also closes on an outside click,
 * Escape or a pick. Wider screens show the links inline instead (TopBar), and hide this.
 */
import Link from "next/link";
import { useEffect, useRef } from "react";

export function NavMenu({ links }: { links: { href: string; label: string }[] }) {
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
    <details className="nav-menu" ref={ref} data-testid="nav-menu">
      <summary aria-label="Menu">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </summary>
      <ul onClick={() => ref.current?.removeAttribute("open")}>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href}>{l.label}</Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
