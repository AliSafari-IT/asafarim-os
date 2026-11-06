import { AppBrand, AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { LocaleSelector } from "@asafarim/locale/react";
import { getLocale } from "@asafarim/locale/next";
import { ThemeToggle } from "@asafarim/theme/react";
import { createNoteAction, signInAction, signOutAction } from "./actions";
import { SignOutIcon } from "@/components/SignOutIcon";
import { auth } from "@/lib/auth";
import { listNotes } from "@/lib/db";
import { describeAccess } from "@/lib/gate";
import { messagesFor } from "@/lib/i18n";
import { getPlatform } from "@/lib/platform";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { error, permission } = await searchParams;
  const locale = await getLocale();
  const m = messagesFor(locale);
  const session = await auth();
  const subject = session?.user?.id;

  if (!subject) {
    return (
      <>
        <header className="os-topbar">
          <div className="topbar-inner">
            <h1>Notes</h1>
            <span className="tools">
              <LocaleSelector locale={locale} />
              <ThemeToggle locale={locale} />
            </span>
          </div>
        </header>
        <main>
          <div className="card">
            <p>{m.signInIntro}</p>
            <form action={signInAction}>
              <button type="submit">{m.signIn}</button>
            </form>
          </div>
        </main>
      </>
    );
  }

  const access = await describeAccess(subject);
  // The apps this person can open (active, and they hold a role or it is public), decided by core-api.
  // A launcher that can't be loaded is left out: it must never break the page.
  const apps = await getPlatform()
    .access.launcher(subject)
    .catch(() => []);
  const canRead = access.permissions.includes("notes.read");
  const canWrite = access.permissions.includes("notes.write");
  const notes = access.state === "active" && canRead ? await listNotes(100) : [];

  return (
    <>
      <header className="topbar os-topbar">
        <div className="topbar-inner">
          <div className="brand">
            <AppBrand name="Notes" glyph="NT" as="h1" />
          </div>
          <span className="tools" data-testid="who">
            <LocaleSelector locale={locale} />
            <ThemeToggle locale={locale} />
            {/* The OS's app switcher, as an icon next to the account menu: the brand is on the left (#288). */}
            <AppSwitcher
              apps={apps}
              current="notes"
              fallback={{ name: "Notes", glyph: "NT" }}
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

      <main>
        {error ? (
          <div className="notice bad" role="alert" data-testid="error">
            {m.errors[error] ?? error}
            {permission ? (
              <>
                {" "}
                <span className="perm">{permission}</span>
              </>
            ) : null}
          </div>
        ) : null}

        {!access.available ? (
          <div className="notice bad" data-testid="state">
            {m.permissionsUnavailable}
          </div>
        ) : access.state !== "active" ? (
          <div className="notice bad" data-testid="state">
            {m.stateBefore}
            <strong>{access.state}</strong>
            {m.stateAfter}
          </div>
        ) : (
          <>
            <p className="muted" data-testid="access">
              {m.yourRoles}: {access.roles.join(", ") || m.none} · {m.permissions}:{" "}
              <span className="perm">{access.permissions.join(", ") || m.none}</span>
            </p>

            <form action={createNoteAction} className="card" data-testid="new-note">
              <label>
                {m.title}
                <input name="title" maxLength={200} required />
              </label>
              <label>
                {m.note}
                <textarea name="body" rows={3} maxLength={10000} />
              </label>
              <button type="submit">{m.addNote}</button>
              {!canWrite ? (
                <span className="muted">
                  {" "}
                  {m.needsWrite} <span className="perm">notes.write</span>.
                </span>
              ) : null}
            </form>

            {canRead ? (
              notes.length ? (
                notes.map((n) => (
                  <article className="card" key={n.id} data-testid="note">
                    <h2>{n.title}</h2>
                    <span className="muted">
                      {n.author} · {n.created_at.toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                    {n.body ? <p>{n.body}</p> : null}
                  </article>
                ))
              ) : (
                <p className="muted" data-testid="empty">
                  {m.noNotes}
                </p>
              )
            ) : (
              <div className="notice" data-testid="no-read">
                {m.needsRead} <span className="perm">notes.read</span>. {m.askAdmin}{" "}
                <span className="perm">notes.viewer</span>.
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
