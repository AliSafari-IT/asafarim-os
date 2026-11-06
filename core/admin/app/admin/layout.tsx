import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { ThemeToggle } from "@asafarim/theme/react";
import Link from "next/link";
import { AdminLogo } from "@/components/AdminLogo";
import { Nav } from "@/components/Nav";
import { SignOutIcon } from "@/components/SignOutIcon";
import { messagesFor } from "@/lib/i18n";
import { coreApi } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { signOutAction } from "@/lib/sign-out";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const m = messagesFor(locale);
  const admin = await requireAdmin(); // a redirect to sign-in, or a 403, before anything is shown
  // The apps this admin can open, decided by core-api. A launcher that can't be loaded is left out:
  // it must never break the console.
  const apps = await coreApi(admin.idToken)
    .launcher()
    .catch(() => []);
  return (
    <>
      <a className="skip" href="#main">
        {m.skipToContent}
      </a>
      <header className="top os-topbar">
        <div className="top-inner">
          <div className="brand">
            <h1>
              <Link className="wordmark" href="/admin">
                <AdminLogo />
                <span>
                  ASafariM OS <span>Admin</span>
                </span>
              </Link>
            </h1>
          </div>
          <Nav locale={locale} />
          <div className="who" data-testid="who">
            <LocaleSelector locale={locale} />
            <ThemeToggle locale={locale} />
            {/* The OS's app switcher, as an icon next to the account menu: the wordmark is the brand (#288).
                Admin isn't an app in the launcher, so its accessible name comes from the fallback. */}
            <AppSwitcher
              apps={apps}
              current="admin"
              fallback={{ name: "Admin", glyph: "AD" }}
              variant="icon"
              locale={locale}
            />
            <UserMenu
              name={admin.name}
              email={admin.email}
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
          </div>
        </div>
      </header>
      <div className="shell">
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
