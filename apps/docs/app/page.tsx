import { AppBrand, AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
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
import { messagesFor } from "@/lib/i18n";
import { issuesConfigured } from "@/lib/issue-api";
import { docHref } from "@/lib/links";
import { getNotes, issueViaFlow } from "@/lib/notes";
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
  const locale = await getLocale();
  const m = messagesFor(locale);
  // The gate comes first (#79): signed out is a 401 sign-in page, no docs.read a plain 403 page.
  const g = await gate("docs.read");
  if (!g.ok && g.status === 401) unauthorized();
  if (!g.ok && g.status === 403) forbidden();
  if (!g.ok) {
    return (
      <div className="signin">
        <span className="corner-toggle">
          <LocaleSelector locale={locale} />
          <ThemeToggle locale={locale} />
        </span>
        <h1>Docs</h1>
        <p className="notice" role="status" data-testid="state">
          {g.body.error === "app_inactive" ? (
            <>
              {m.appIsBefore}
              <strong>{g.body.state}</strong>
              {m.appIsAfter}
            </>
          ) : (
            m.permissionsUnavailable
          )}
        </p>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            {m.signOut}
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
            viaFlow: issueViaFlow(n),
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
        {m.skipToDocument}
      </a>
      <header className="topbar os-topbar">
        <div className="brand">
          <AppBrand name="Docs" glyph="DC" />
          <span className="muted mono" data-testid="source">
            {repo}
          </span>
          {view.status === "ok" && view.mode === "fixtures" ? (
            <span className="badge" data-testid="fixtures">
              {m.localFixtures}
            </span>
          ) : null}
        </div>
        <div className="who">
          {view.status === "ok" ? <Search /> : null}
          <form action={refreshAction}>
            {selected ? <input type="hidden" name="doc" value={selected} /> : null}
            <button type="submit" className="secondary" data-testid="refresh">
              {m.refresh}
            </button>
          </form>
          <a className="button secondary" href="/notes" data-testid="all-notes">
            {m.allNotes}
          </a>
          <LocaleSelector locale={locale} />
          <ThemeToggle locale={locale} />
          {/* The OS's app switcher, as an icon next to the account menu: the brand is on the left (#288). */}
          <AppSwitcher
            apps={apps}
            current="docs"
            fallback={{ name: "Docs", glyph: "DC" }}
            variant="icon"
            locale={locale}
          />
          <span data-testid="who">
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

      {view.status === "unavailable" ? (
        <p className="notice" role="status" data-testid="unavailable">
          {m.unavailable}
        </p>
      ) : view.status === "ok" && view.ownersError ? (
        <p className="notice" role="status" data-testid="owners-error">
          {view.ownersError}. <span className="mono">{repo}</span> {m.ownersErrorTail}.
        </p>
      ) : null}

      <ReaderShell
        nodes={view.status === "ok" ? toNav(view.tree) : []}
        selected={selected}
        toc={
          doc && !doc.missing ? (
            <Toc items={tocOf(doc.headings)} />
          ) : (
            <p className="muted">{home ? m.openToSeeSections : m.nothingOpen}</p>
          )
        }
      >
        <main id="document" className="document" tabIndex={-1}>
          <article>
            {doc?.missing ? (
              <>
                <h1>{m.notFound}</h1>
                <p className="lead">
                  <span className="mono">{doc.path}</span> {m.notInSource}
                </p>
              </>
            ) : doc && view.status === "ok" ? (
              <>
                {doc.breadcrumb.length ? (
                  <nav aria-label={m.breadcrumb} className="crumbs" data-testid="breadcrumb">
                    <ol>
                      {doc.breadcrumb.map((c, i) => (
                        <li key={`${i}:${c}`}>{c}</li>
                      ))}
                    </ol>
                  </nav>
                ) : null}
                <h1 data-testid="doc-title">{doc.title}</h1>
                <p className="meta">
                  <span className="badge owner" data-testid="owner" title={m.ownerFrom(doc.owner.via)}>
                    {doc.owner.repo}
                  </span>
                  <span className="muted" data-testid="stats">
                    {m.minRead(doc.stats.minutes)} · {m.words(doc.stats.words.toLocaleString(locale))}
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
                  <nav className="pager" aria-label={m.previousNext} data-testid="pager">
                    {pager.prev ? (
                      <Link className="prev" href={docHref(pager.prev.path)} data-testid="pager-prev">
                        <span className="dir">{m.previous}</span>
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
                        <span className="dir">{m.next}</span>
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
                  <p className="eyebrow">{m.documentation}</p>
                  <h1>{home.start ? m.welcome : m.documentsTitle}</h1>
                  <p className="lead">
                    {m.documentCount(view.docCount.toLocaleString(locale), view.docCount)}{" "}
                    <span className="mono">{repo}</span>
                    {m.searchWith} <kbd>⌘K</kbd> {m.or} <kbd>Ctrl K</kbd>.
                  </p>
                </header>
                {home.start ? (
                  <Link className="card start" href={docHref(home.start.path)} data-testid="home-start">
                    <span className="eyebrow">{m.startHere}</span>
                    <span className="card-title">{home.start.label}</span>
                    <span className="muted">{m.overview}</span>
                  </Link>
                ) : null}
                {home.sections.length ? (
                  <ul className="cards" aria-label={m.sections} data-testid="home-sections">
                    {home.sections.map((section) => (
                      <li key={section.label} className="card section">
                        <h2>
                          {section.label}
                          <span className="count">{m.docsCount(section.count)}</span>
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
                        {section.more ? <p className="muted more">{m.moreInSidebar(section.more)}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {home.loose.length ? (
                  <section className="loose" aria-labelledby="loose-title">
                    <h2 id="loose-title">{m.topLevel}</h2>
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
                    {m.noDocuments} <span className="mono">{repo}</span>.
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <h1>{m.nothingOpen.replace(/\.$/, "")}</h1>
                <p className="lead">{m.nothingOpenLead}</p>
              </>
            )}
          </article>
        </main>
      </ReaderShell>
    </>
  );
}
