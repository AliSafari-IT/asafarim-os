import { UserMenu } from "@asafarim/app-sdk/react";
import { Nav } from "@/components/Nav";
import { SignOutIcon } from "@/components/SignOutIcon";
import { signOut } from "@/lib/auth";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/signin" });
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin(); // a redirect to sign-in, or a 403, before anything is shown
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <header className="top">
          <h1>ASafariM OS Admin</h1>
          <Nav />
          <div className="who" data-testid="who">
            <UserMenu
              name={admin.name}
              email={admin.email}
              signOut={
                <form action={signOutAction}>
                  <button type="submit" data-testid="sign-out">
                    <SignOutIcon />
                    Sign out
                  </button>
                </form>
              }
            />
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
