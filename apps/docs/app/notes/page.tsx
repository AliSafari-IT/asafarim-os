import { AppBrand, AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { forbidden, unauthorized } from "next/navigation";
import { signOutAction } from "../actions";
import { SignOutIcon } from "@/components/SignOutIcon";
import { IssueLink } from "@/components/IssueLink";
import { Markdown } from "@/components/Markdown";
import { anchorNote, sectionsOf, type Section } from "@/lib/anchor";
import { auth } from "@/lib/auth";
import { gate } from "@/lib/gate";
import { messagesFor } from "@/lib/i18n";
import { getNotes, issueViaFlow, type Note } from "@/lib/notes";
import { readableName } from "@/lib/outline";
import { getPlatform } from "@/lib/platform";
import { docParam } from "@/lib/reader";
import { DocNotFoundError, getSource, SourceUnavailableError } from "@/lib/source";

export const dynamic = "force-dynamic";

const docHref = (path: string, heading = "") =>
  `/?doc=${encodeURIComponent(path)}${heading ? `#${encodeURIComponent(heading)}` : ""}`;

/**
 * /notes (#81): every note of the signed-in owner, by document, filterable by document. A note whose
 * text was edited away is marked "text changed"; one whose document is gone says so. Notes are
 * edited on their document.
 */
export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const locale = await getLocale();
  const m = messagesFor(locale);
  const g = await gate("docs.read");
  if (!g.ok && g.status === 401) unauthorized();
  if (!g.ok && g.status === 403) forbidden();
  if (!g.ok) {
    return (
      <p className="notice" role="status" data-testid="state">
        {g.body.message}
      </p>
    );
  }
  const session = await auth();
  const filter = docParam((await searchParams).doc);
  const store = getNotes();
  const config = getPlatform().config;
  const source = getSource({ repo: config.getString("source.repo"), branch: config.getString("source.branch") });

  let all: Note[] | undefined;
  try {
    all = store ? await store.list(g.subject) : undefined;
  } catch (err) {
    console.warn(JSON.stringify({ app: "docs", level: "warn", msg: "notes.unavailable", error: String(err) }));
  }
  const docsWithNotes = [...new Set((all ?? []).map((n) => n.docPath))];
  const shown = (all ?? []).filter((n) => !filter || n.docPath === filter);

  // Each document once: its sections (to place its notes), "gone" when it isn't in the source any
  // more, or unknown when the source can't be read right now.
  const groups: { path: string; sections: Section[] | "gone" | "unavailable"; notes: Note[] }[] = [];
  let listing: { docs: string[]; images: string[] } = { docs: [], images: [] };
  try {
    const l = await source.listDocs();
    listing = {
      docs: l.entries.filter((e) => e.kind === "doc").map((e) => e.path),
      images: l.entries.filter((e) => e.kind === "image").map((e) => e.path),
    };
  } catch (err) {
    if (!(err instanceof SourceUnavailableError)) throw err;
  }
  for (const path of [...new Set(shown.map((n) => n.docPath))]) {
    let sections: Section[] | "gone" | "unavailable";
    try {
      sections = sectionsOf(await source.readDoc(path));
    } catch (err) {
      if (err instanceof DocNotFoundError) sections = "gone";
      else if (err instanceof SourceUnavailableError) sections = "unavailable";
      else throw err;
    }
    groups.push({ path, sections, notes: shown.filter((n) => n.docPath === path) });
  }

  // A launcher that can't be loaded is left out: it must never break the page.
  const apps = await getPlatform()
    .access.launcher(g.subject)
    .catch(() => []);

  return (
    <>
      <a className="skip" href="#all-notes">
        {m.skipToNotes}
      </a>
      <header className="topbar os-topbar">
        <div className="brand">
          <AppBrand name="Docs" glyph="DC" />
        </div>
        <div className="who">
          <a className="button secondary" href="/">
            {m.documents}
          </a>
          <LocaleSelector locale={locale} />
          <ThemeToggle locale={locale} />
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
      <main id="all-notes" className="document" tabIndex={-1}>
        <article>
          <h1>{m.yourNotes}</h1>
          {!store || !all ? (
            <p className="notice" role="status" data-testid="notes-unavailable">
              {m.notesUnavailable}
            </p>
          ) : all.length === 0 ? (
            <p className="lead">
              {m.noNotesYetPage} <strong>{m.addNoteBold}</strong>.
            </p>
          ) : (
            <>
              <form className="notes-filter" method="get" action="/notes">
                <label>
                  {m.document}
                  <select name="doc" defaultValue={filter ?? ""} data-testid="notes-filter">
                    <option value="">{m.allDocuments}</option>
                    {docsWithNotes.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="secondary">
                  {m.show}
                </button>
              </form>
              <p className="muted">{m.notesPrivate}</p>
              {groups.map((group) => (
                <section
                  key={group.path}
                  className="notes"
                  aria-labelledby={`doc-${group.path}`}
                  data-testid="notes-doc"
                >
                  <h2 id={`doc-${group.path}`}>
                    {group.sections === "gone" ? (
                      readableName(group.path.split("/").at(-1)!)
                    ) : (
                      <a href={docHref(group.path)}>{readableName(group.path.split("/").at(-1)!)}</a>
                    )}{" "}
                    <span className="muted mono">{group.path}</span>
                  </h2>
                  {group.sections === "gone" ? (
                    <p className="notice" role="status">
                      {m.goneKept}
                    </p>
                  ) : null}
                  <ol className="note-list">
                    {group.notes.map((n) => {
                      const sections = Array.isArray(group.sections) ? group.sections : undefined;
                      const at = sections ? anchorNote(n, sections) : undefined;
                      const title = sections?.find((s) => s.id === (at?.headingId ?? n.headingId))?.title;
                      return (
                        <li key={n.id}>
                          <article className="note" data-testid="note" data-status={at?.status ?? "unknown"}>
                            <p className="note-where">
                              {sections ? (
                                <a href={docHref(n.docPath, at?.headingId)}>{title || m.wholeDocument}</a>
                              ) : (
                                n.headingId || m.wholeDocument
                              )}
                              {at?.status === "changed" ? (
                                <span className="badge warn" data-testid="text-changed" title={m.textChangedWhy}>
                                  {m.textChanged}
                                </span>
                              ) : null}
                            </p>
                            {n.quote ? <blockquote className="note-quote">{n.quote}</blockquote> : null}
                            <div className="note-body">
                              <Markdown
                                markdown={n.body}
                                fromDoc={n.docPath}
                                docs={listing.docs}
                                images={listing.images}
                                variant="note"
                              />
                            </div>
                            <p className="note-foot muted">
                              <span>{n.updatedAt.slice(0, 10)}</span>
                              <IssueLink url={n.issueUrl} viaFlow={issueViaFlow(n)} />
                            </p>
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </>
          )}
        </article>
      </main>
    </>
  );
}
