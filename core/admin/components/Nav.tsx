"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin/apps", label: "Apps" },
  { href: "/admin/roles", label: "Roles & grants" },
  { href: "/admin/audit", label: "Audit" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin">
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} aria-current={pathname.startsWith(l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
