import { Launcher } from "@asafarim/app-sdk/react";
import Link from "next/link";
import { refreshAction, signInAction, signOutAction } from "./actions";
import { auth } from "@/lib/auth";
import { describeAccess } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";
import { docParam, loadReader, type TreeNode } from "@/lib/reader";
import { getSource } from "@/lib/source";

export const dynamic = "force-dynamic";

function Tree({ nodes, selected }: { nodes: TreeNode[]; selected?: string }) {
  return (
    <ul>
      {nodes.map((n) =>
        n.entry ? (
          <li key={n.entry.path}>
            {n.entry.kind === "doc" ? (
              <Link
                href={`/?doc=${encodeURIComponent(n.entry.path)}`}
                aria-current={n.entry.path === selected ? "page" : undefined}
                data-testid={`doc-${n.entry.path}`}
              >
                {n.name.replace(/\.md$/i, "")}
              </Link>
            ) : (
              <a href={`/api/files/${n.entry.path.split("/").map(encodeURIComponent).join("/")}`} className="file">
                {n.name}
              </a>
            )}
          </li>
        ) : (
          <li key={`dir:${n.name}`} className="folder">
            <span>{n.name}</span>
            <Tree nodes={n.children} selected={selected} />
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * The reading layout: the file tree on the left, the document in the centre, its table of contents
 * on the right (#80). Documents come from the source repository at runtime (lib/source.ts).
 */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
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

  const selected = docParam((await searchParams).doc);
  const access = await describeAccess(subject);
  // A launcher that can't be loaded is left out: it must never break the page.
  const apps = await getPlatform()
    .access.launcher(subject)
    .catch(() => []);
  const config = getPlatform().config;
  const repo = config.getString("source.repo");
  const canRead = access.state === "active" && access.permissions.includes("docs.read");
  const view = canRead
    ? await loadReader(getSource({ repo, branch: config.getString("source.branch") }), {
        doc: selected,
        sourceRepo: repo,
      })
    : undefined;
  const doc = view?.status === "ok" ? view.doc : undefined;

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
          {view?.status === "ok" && view.mode === "fixtures" ? (
            <span className="badge" data-testid="fixtures">
              local fixtures
            </span>
          ) : null}
        </div>
        <div className="who">
          {canRead ? (
            <form action={refreshAction}>
              {selected ? <input type="hidden" name="doc" value={selected} /> : null}
              <button type="submit" className="secondary" data-testid="refresh">
                Refresh
              </button>
            </form>
          ) : null}
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
      ) : !canRead ? (
        <p className="notice" role="status" data-testid="no-read">
          Reading needs the permission <span className="mono">docs.read</span>. Ask an admin for the{" "}
          <span className="mono">docs.owner</span> role.
        </p>
      ) : view?.status === "unavailable" ? (
        <p className="notice" role="status" data-testid="unavailable">
          Documents temporarily unavailable. Try Refresh in a minute.
        </p>
      ) : view?.ownersError ? (
        <p className="notice" role="status" data-testid="owners-error">
          {view.ownersError}. Every document is shown as owned by <span className="mono">{repo}</span> until it&apos;s
          fixed.
        </p>
      ) : null}

      <div className="reader" data-testid="reader">
        <nav className="tree" aria-label="Documents">
          <h2>Documents</h2>
          {view?.status === "ok" && view.tree.length ? (
            <Tree nodes={view.tree} selected={selected} />
          ) : (
            <p className="muted" data-testid="tree-empty">
              No documents yet.
            </p>
          )}
        </nav>
        <main id="document" className="document" tabIndex={-1}>
          <article>
            {doc?.missing ? (
              <>
                <h1>Not found</h1>
                <p className="lead">
                  <span className="mono">{doc.path}</span> isn&apos;t in the source repository (any more).
                </p>
              </>
            ) : doc ? (
              <>
                <h1 data-testid="doc-title">{doc.title}</h1>
                <p className="meta">
                  <span className="badge owner" data-testid="owner" title={`Owner (from ${doc.owner.via})`}>
                    {doc.owner.repo}
                  </span>{" "}
                  <span className="muted mono">{doc.path}</span>
                </p>
                <pre className="raw" data-testid="doc-raw">
                  {doc.markdown}
                </pre>
              </>
            ) : (
              <>
                <h1>Nothing open</h1>
                <p className="lead">
                  Pick a document on the left to read it here. Documents are loaded from{" "}
                  <span className="mono">{repo}</span> when you open them; none are stored in this app.
                </p>
              </>
            )}
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
