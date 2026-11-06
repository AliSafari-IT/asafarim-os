"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { messagesFor } from "@/lib/i18n";
import type { Locale } from "@asafarim/locale";

const LINKS = [
  { href: "/admin/apps", key: "apps" },
  { href: "/admin/status", key: "status" },
  { href: "/admin/events", key: "events" },
  { href: "/admin/roles", key: "roles" },
  { href: "/admin/audit", key: "audit" },
] as const;

export function Nav({ locale = "en" }: { locale?: Locale }) {
  const pathname = usePathname();
  const m = messagesFor(locale);
  return (
    <nav aria-label={m.adminNav}>
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} aria-current={pathname.startsWith(l.href) ? "page" : undefined}>
              {m.nav[l.key]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
