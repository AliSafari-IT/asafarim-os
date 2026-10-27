import { AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { signOutAction } from "@/app/actions";
import { SignOutIcon } from "@/components/SignOutIcon";
import { auth } from "@/lib/auth";
import { getPlatform } from "@/lib/platform";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/runs", label: "Runs" },
  { href: "/approvals", label: "Approvals" },
  { href: "/workflows", label: "Workflows" },
] as const;

/** The OS top bar (app switcher, theme, account menu) and Flow's own navigation, around a page. */
export async function Shell({
  current,
  children,
}: {
  current: (typeof NAV)[number]["href"];
  children: React.ReactNode;
}) {
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
            <span className="visually-hidden">Flow</span>
            <AppSwitcher apps={apps} current="flow" fallback={{ name: "Flow", glyph: "FL" }} />
          </div>
          <span className="tools" data-testid="who">
            <ThemeToggle />
            <UserMenu
              name={session?.user?.name}
              email={session?.user?.email}
              signOut={
                <form action={signOutAction}>
                  <button type="submit" data-testid="sign-out">
                    <SignOutIcon />
                    Sign out
                  </button>
                </form>
              }
            />
          </span>
        </div>
      </header>
      <nav className="tabs" aria-label="Flow">
        <div className="tabs-inner">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.href === current ? "page" : undefined}>
              {n.label}
            </a>
          ))}
        </div>
      </nav>
      <main>{children}</main>
    </>
  );
}
