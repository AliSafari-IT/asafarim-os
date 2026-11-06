import { AppBrand, AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { signOutAction } from "@/app/actions";
import { SignOutIcon } from "@/components/SignOutIcon";
import { auth } from "@/lib/auth";
import { messagesFor } from "@/lib/i18n";
import { getPlatform } from "@/lib/platform";

const NAV = [
  { href: "/", key: "overview" },
  { href: "/runs", key: "runs" },
  { href: "/approvals", key: "approvals" },
  { href: "/workflows", key: "workflows" },
  { href: "/credentials", key: "credentials" },
  { href: "/settings", key: "settings" },
] as const;

/** The OS top bar (app switcher, theme, account menu) and Flow's own navigation, around a page. */
export async function Shell({
  current,
  wide = false,
  children,
}: {
  current: (typeof NAV)[number]["href"];
  /** The whole width of the window (the builder), not the page column. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const m = messagesFor(locale);
  const session = await auth();
  // The apps this person can open, decided by core-api. A launcher that can't be loaded is left out.
  const apps = session?.user?.id
    ? await getPlatform()
        .access.launcher(session.user.id)
        .catch(() => [])
    : [];
  return (
    <>
      <header className="topbar os-topbar">
        <div className="topbar-inner">
          <div className="brand">
            <AppBrand name="Flow" glyph="FL" />
          </div>
          <span className="tools" data-testid="who">
            <LocaleSelector locale={locale} />
            <ThemeToggle locale={locale} />
            {/* The OS's app switcher, as an icon next to the account menu: the brand is on the left (#288). */}
            <AppSwitcher
              apps={apps}
              current="flow"
              fallback={{ name: "Flow", glyph: "FL" }}
              variant="icon"
              locale={locale}
            />
            <UserMenu
              name={session?.user?.name}
              email={session?.user?.email}
              locale={locale}
              signOut={
                <form action={signOutAction}>
                  <button type="submit" data-testid="sign-out">
                    <SignOutIcon />
                    {m.signOut}
                  </button>
                </form>
              }
            />
          </span>
        </div>
      </header>
      <nav className="tabs" aria-label={m.tabsLabel}>
        <div className="tabs-inner">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.href === current ? "page" : undefined}>
              {m.tabs[n.key]}
            </a>
          ))}
        </div>
      </nav>
      <main className={wide ? "wide" : undefined}>{children}</main>
    </>
  );
}
