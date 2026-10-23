import { AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { ThemeToggle } from "@asafarim/theme/react";
import Link from "next/link";
import { forbidden, unauthorized } from "next/navigation";
import { refreshAction, signOutAction } from "./actions";
import { SignOutIcon } from "@/components/SignOutIcon";
import { Markdown } from "@/components/Markdown";
import type { NavNode } from "@/components/nav";
import { Notes, type NoteView } from "@/components/Notes";
import { ReaderShell } from "@/components/ReaderShell";
import { Search } from "@/components/Search";
import { Toc } from "@/components/Toc";
import { auth } from "@/lib/auth";
import { anchorNote, sectionsOf } from "@/lib/anchor";
import { gate } from "@/lib/gate";
import { homeOf, neighboursOf } from "@/lib/home";
import { issuesConfigured } from "@/lib/issue-api";
import { docHref } from "@/lib/links";
import { getNotes } from "@/lib/notes";
import { readableName, tocOf } from "@/lib/outline";
import { getPlatform } from "@/lib/platform";
import { docParam, loadReader, type TreeNode } from "@/lib/reader";
import { getSource } from "@/lib/source";

export const dynamic = "force-dynamic";

/** The tree as the browser gets it: readable names, worked out here. */
function toNav(nodes: TreeNode[]): NavNode[] {
  return nodes.map((n) =>
    n.entry
      ? {
          label: n.entry.kind === "doc" ? readableName(n.name) : n.name,
          path: n.entry.path,
          kind: n.entry.kind,
          children: [],
        }
      : { label: readableName(n.name), children: toNav(n.children) },
  );
}

/**
 * The reading layout (#80): the documents on the left (a drawer on a phone), the rendered document
 * in the centre, "On this page" on the right, ⌘K search in the top bar. Documents come from the source repository at runtime (lib/source.ts).
 */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  // The gate comes first (#79): signed out is a 401 sign-in page, no docs.read a plain 403 page.
  const g = await gate("docs.read");
  if (!g.ok && g.status === 401) unauthorized();
  if (!g.ok && g.status === 403) forbidden();
  if (!g.ok) {
    return (
      <div className="signin">
        <ThemeToggle className="corner-toggle" />
        <h1>Docs</h1>
        <p className="notice" role="status" data-testid="state">
          {g.body.error === "app_inactive" ? (
            <>
              This app is <strong>{g.body.state}</strong>. An admin has to activate it.
            </>
          ) : (
            "Permissions can't be checked right now (core-api is unreachable)."
          )}
        </p>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </div>
    );
  }

  const session = await auth();
  const subject = g.subject;
  const selected = docParam((await searchParams).doc);
  // A launcher that can't be loaded is left out: it must never break the page.
  const apps = await getPlatform()
    .access.launcher(subject)
    .catch(() => []);
  const config = getPlatform().config;
  const repo = config.getString("source.repo");
  const view = await loadReader(getSource({ repo, branch: config.getString("source.branch") }), {
    doc: selected,
    sourceRepo: repo,
  });
  const doc = view.status === "ok" ? view.doc : undefined;
  // Nothing open: the home page. A document: the ones before and after it in the sidebar.
  const home = view.status === "ok" && !selected ? homeOf(view.tree) : undefined;
  const pager: ReturnType<typeof neighboursOf> =
    view.status === "ok" && doc && !doc.missing ? neighboursOf(view.tree, doc.path) : {};

  // Study notes (#81): the caller's own, each placed where its quote is in this version of the document.
  const store = getNotes();
  const canWrite = (await gate("docs.notes.write")).ok;
  // "Generate GitHub issue" (#82): for docs.issues.create, working once the server has its secrets.
  const issues = { allowed: (await gate("docs.issues.create")).ok, ready: issuesConfigured() };
  let notesAvailable = Boolean(store);
  let notes: NoteView[] = [];
  const sections = doc && !doc.missing ? sectionsOf(doc.markdown) : [];
  if (store && doc && !doc.missing && view.status === "ok") {
    try {
      const own = await store.list(subject, doc.path);
      const order = new Map(sections.map((s, i) => [s.id, i]));
      notes = own
        .map((n) => {
          const at = anchorNote(n, sections);
          return {
            id: n.id,
            headingId: at.headingId,
            headingTitle: sections.find((s) => s.id === at.headingId)?.title ?? "",
            quote: n.quote,
            body: n.body,
            status: at.status,
            updatedAt: n.updatedAt,
            issueUrl: n.issueUrl,
            rendered: (
              <Markdown
                markdown={n.body}
                fromDoc={doc.path}
                docs={view.paths.docs}
                images={view.paths.images}
                variant="note"
              />
            ),
          };
        })
        .sort((a, b) => (order.get(a.headingId) ?? 0) - (order.get(b.headingId) ?? 0) || Number(a.id) - Number(b.id));
    } catch (err) {
      console.warn(JSON.stringify({ app: "docs", level: "warn", msg: "notes.unavailable", error: String(err) }));
      notesAvailable = false;
    }
  }

  return (
    <>
      <a className="skip" href="#document">
        Skip to the document
      </a>
      <header className="topbar os-topbar">
        <div className="brand">
          {/* The OS's app switcher: Docs and every other app this person can open (core-api's launcher). */}
          <AppSwitcher apps={apps} current="docs" fallback={{ name: "Docs", glyph: "DC" }} />
          <span className="muted mono" data-testid="source">
            {repo}
          </span>
          {view.status === "ok" && view.mode === "fixtures" ? (
            <span className="badge" data-testid="fixtures">
              local fixtures
            </span>
          ) : null}
        </div>
        <div className="who">
          {view.status === "ok" ? <Search /> : null}
          <form action={refreshAction}>
            {selected ? <input type="hidden" name="doc" value={selected} /> : null}
            <button type="submit" className="secondary" data-testid="refresh">
              Refresh
            </button>
          </form>
          <a className="button secondary" href="/notes" data-testid="all-notes">
            All notes
          </a>
          <ThemeToggle />
          <span data-testid="who">
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

      {view.status === "unavailable" ? (
        <p className="notice" role="status" data-testid="unavailable">
          Documents temporarily unavailable. Try Refresh in a minute.
        </p>
      ) : view.status === "ok" && view.ownersError ? (
        <p className="notice" role="status" data-testid="owners-error">
          {view.ownersError}. Every document is shown as owned by <span className="mono">{repo}</span> until it&apos;s
          fixed.
        </p>
      ) : null}

      <ReaderShell
        nodes={view.status === "ok" ? toNav(view.tree) : []}
        selected={selected}
        toc={
          doc && !doc.missing ? (
            <Toc items={tocOf(doc.headings)} />
          ) : (
            <p className="muted">{home ? "Open a document to see its sections here." : "Nothing open."}</p>
          )
        }
      >
        <main id="document" className="document" tabIndex={-1}>
          <article>
            {doc?.missing ? (
              <>
                <h1>Not found</h1>
                <p className="lead">
                  <span className="mono">{doc.path}</span> isn&apos;t in the source repository (any more).
                </p>
              </>
            ) : doc && view.status === "ok" ? (
              <>
                {doc.breadcrumb.length ? (
                  <nav aria-label="Breadcrumb" className="crumbs" data-testid="breadcrumb">
                    <ol>
                      {doc.breadcrumb.map((c, i) => (
                        <li key={`${i}:${c}`}>{c}</li>
                      ))}
                    </ol>
                  </nav>
                ) : null}
                <h1 data-testid="doc-title">{doc.title}</h1>
                <p className="meta">
                  <span className="badge owner" data-testid="owner" title={`Owner (from ${doc.owner.via})`}>
                    {doc.owner.repo}
                  </span>
                  <span className="muted" data-testid="stats">
                    {doc.stats.minutes} min read · {doc.stats.words.toLocaleString("en")} words
                  </span>
                </p>
                <Notes
                  docPath={doc.path}
                  headings={sections.filter((s) => s.id).map((s) => ({ id: s.id, title: s.title }))}
                  notes={notes}
                  canWrite={canWrite}
                  available={notesAvailable}
                  issues={issues}
                >
                  <Markdown
                    markdown={doc.markdown}
                    fromDoc={doc.path}
                    docs={view.paths.docs}
                    images={view.paths.images}
                  />
                </Notes>
                {pager.prev || pager.next ? (
                  <nav className="pager" aria-label="Previous and next document" data-testid="pager">
                    {pager.prev ? (
                      <Link className="prev" href={docHref(pager.prev.path)} data-testid="pager-prev">
                        <span className="dir">Previous</span>
                        <span className="title">
                          {pager.prev.where ? <span className="where">{pager.prev.where} · </span> : null}
                          {pager.prev.label}
                        </span>
                      </Link>
                    ) : (
                      <span />
                    )}
                    {pager.next ? (
                      <Link className="next" href={docHref(pager.next.path)} data-testid="pager-next">
                        <span className="dir">Next</span>
                        <span className="title">
                          {pager.next.where ? <span className="where">{pager.next.where} · </span> : null}
                          {pager.next.label}
                        </span>
                      </Link>
                    ) : null}
                  </nav>
                ) : null}
              </>
            ) : home && view.status === "ok" ? (
              <div className="home" data-testid="home">
                <header className="home-hero">
                  <p className="eyebrow">Documentation</p>
                  <h1>{home.start ? "Welcome" : "Documents"}</h1>
                  <p className="lead">
                    {view.docCount.toLocaleString("en")} {view.docCount === 1 ? "document" : "documents"} from{" "}
                    <span className="mono">{repo}</span>, read live from the repository. Search with <kbd>⌘K</kbd> or{" "}
                    <kbd>Ctrl K</kbd>.
                  </p>
                </header>
                {home.start ? (
                  <Link className="card start" href={docHref(home.start.path)} data-testid="home-start">
                    <span className="eyebrow">Start here</span>
                    <span className="card-title">{home.start.label}</span>
                    <span className="muted">The overview of this documentation.</span>
                  </Link>
                ) : null}
                {home.sections.length ? (
                  <ul className="cards" aria-label="Sections" data-testid="home-sections">
                    {home.sections.map((section) => (
                      <li key={section.label} className="card section">
                        <h2>
                          {section.label}
                          <span className="count">
                            {section.count} {section.count === 1 ? "doc" : "docs"}
                          </span>
                        </h2>
                        <ul>
                          {section.docs.map((d) => (
                            <li key={d.path}>
                              <Link href={docHref(d.path)}>
                                {d.where ? <span className="where">{d.where}</span> : null}
                                <span>{d.label}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                        {section.more ? <p className="muted more">and {section.more} more in the sidebar</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {home.loose.length ? (
                  <section className="loose" aria-labelledby="loose-title">
                    <h2 id="loose-title">Also at the top level</h2>
                    <ul>
                      {home.loose.map((d) => (
                        <li key={d.path}>
                          <Link href={docHref(d.path)}>{d.label}</Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {view.docCount === 0 ? (
                  <p className="lead" data-testid="home-empty">
                    There are no documents in <span className="mono">{repo}</span> yet.
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <h1>Nothing open</h1>
                <p className="lead">
                  Pick a document to read it here. Documents are loaded from <span className="mono">{repo}</span> when
                  you open them; none are stored in this app.
                </p>
              </>
            )}
          </article>
        </main>
      </ReaderShell>
    </>
  );
}
