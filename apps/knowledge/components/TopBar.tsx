/**
 * The OS top bar on every page: the brand, the theme toggle and, for a signed-in person, the app
 * switcher and account menu. Guests get a sign-in button and nothing that needs core-api. The Studio
 * link is shown only to someone who holds knowledge.content.create (the studio re-checks it anyway).
 */
import { AppBrand, AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { ThemeToggle } from "@asafarim/theme/react";
import Link from "next/link";
import { signInAction, signOutAction } from "@/app/actions";
import { auth } from "@/lib/auth";
import { describeAccess } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";
import { PERMISSIONS } from "@/lib/policy";
import { KnowledgeMark } from "./KnowledgeMark";
import { SignOutIcon } from "./SignOutIcon";

export const APP_NAME = "ASafariM Knowledge";

export async function TopBar({ next = "/" }: { next?: string }) {
  const session = await auth();
  const subject = session?.user?.id;
  const [apps, access] = subject
    ? await Promise.all([
        getPlatform()
          .access.launcher(subject)
          .catch(() => []),
        describeAccess(subject),
      ])
    : [[], null];
  const isAuthor = access?.state === "active" && access.permissions.includes(PERMISSIONS.create);

  return (
    <header className="topbar os-topbar">
      <div className="topbar-inner">
        <AppBrand name={APP_NAME} glyph="KN" icon={<KnowledgeMark />} />
        <nav className="tools" aria-label="Account" data-testid="who">
          <Link href="/search" className="nav-link" data-testid="search-link">
            Search
          </Link>
          {isAuthor ? (
            <Link href="/studio" className="nav-link" data-testid="studio-link">
              Studio
            </Link>
          ) : null}
          <ThemeToggle />
          {subject ? (
            <>
              <AppSwitcher apps={apps} current="knowledge" fallback={{ name: APP_NAME, glyph: "KN" }} variant="icon" />
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
            </>
          ) : (
            <form action={signInAction}>
              <input type="hidden" name="next" value={next} />
              <button type="submit" className="secondary" data-testid="sign-in">
                Sign in
              </button>
            </form>
          )}
        </nav>
      </div>
    </header>
  );
}
