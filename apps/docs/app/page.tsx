import { Launcher } from "@asafarim/app-sdk/react";
import { signInAction, signOutAction } from "./actions";
import { auth } from "@/lib/auth";
import { describeAccess } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";

export const dynamic = "force-dynamic";

/**
 * The reading layout: the file tree on the left, the document in the centre, its table of contents
 * on the right. Empty for now: the documents come from the source repository at runtime (#78).
 */
export default async function Home() {
  const session = await auth();
  const subject = session?.user?.id;

  if (!subject) {
    return (
      <div className="signin">
        <h1>Docs</h1>
        <p className="muted">A private reader for documentation. Sign in with your ASafariM account.</p>
        <form action={signInAction}>
          <button type="submit">Sign in</button>
        </form>
      </div>
    );
  }

  const access = await describeAccess(subject);
  // A launcher that can't be loaded is left out: it must never break the page.
  const apps = await getPlatform()
    .access.launcher(subject)
    .catch(() => []);
  const repo = getPlatform().config.getString("source.repo");

  return (
    <>
      <a className="skip" href="#document">
        Skip to the document
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="glyph" aria-hidden="true">
            DC
          </span>
          <span className="name">Docs</span>
          <span className="muted mono" data-testid="source">
            {repo}
          </span>
        </div>
        <div className="who">
          <span className="muted" data-testid="who">
            {session?.user?.name ?? subject}
          </span>
          <form action={signOutAction}>
            <button type="submit" className="secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className="apps">
        <Launcher apps={apps} current="docs" label="Your apps" />
      </div>

      {!access.available ? (
        <p className="notice" role="status" data-testid="state">
          Permissions can&apos;t be checked right now (core-api is unreachable).
        </p>
      ) : access.state !== "active" ? (
        <p className="notice" role="status" data-testid="state">
          This app is <strong>{access.state}</strong>. An admin has to activate it.
        </p>
      ) : null}

      <div className="reader" data-testid="reader">
        <nav className="tree" aria-label="Documents">
          <h2>Documents</h2>
          <p className="muted" data-testid="tree-empty">
            No documents yet.
          </p>
        </nav>
        <main id="document" className="document" tabIndex={-1}>
          <article>
            <h1>Nothing open</h1>
            <p className="lead">
              Pick a document on the left to read it here. Documents are loaded from{" "}
              <span className="mono">{repo}</span> when you open them; none are stored in this app.
            </p>
          </article>
        </main>
        <aside className="toc" aria-label="On this page">
          <h2>On this page</h2>
          <p className="muted">The headings of the open document.</p>
        </aside>
      </div>
    </>
  );
}
