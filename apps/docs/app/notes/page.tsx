import { AppSwitcher, UserMenu } from "@asafarim/app-sdk/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { forbidden, unauthorized } from "next/navigation";
import { signOutAction } from "../actions";
import { SignOutIcon } from "@/components/SignOutIcon";
import { Markdown } from "@/components/Markdown";
import { anchorNote, sectionsOf, type Section } from "@/lib/anchor";
import { auth } from "@/lib/auth";
import { gate } from "@/lib/gate";
import { issueHref } from "@/lib/issue-link";
import { getNotes, type Note } from "@/lib/notes";
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
        Skip to the notes
      </a>
      <header className="topbar os-topbar">
        <div className="brand">
          <AppSwitcher apps={apps} current="docs" fallback={{ name: "Docs", glyph: "DC" }} />
        </div>
        <div className="who">
          <a className="button secondary" href="/">
            Documents
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
      <main id="all-notes" className="document" tabIndex={-1}>
        <article>
          <h1>Your notes</h1>
          {!store || !all ? (
            <p className="notice" role="status" data-testid="notes-unavailable">
              Notes aren&apos;t available right now.
            </p>
          ) : all.length === 0 ? (
            <p className="lead">
              No notes yet. Open a document, select some text and choose <strong>Add note</strong>.
            </p>
          ) : (
            <>
              <form className="notes-filter" method="get" action="/notes">
                <label>
                  Document
                  <select name="doc" defaultValue={filter ?? ""} data-testid="notes-filter">
                    <option value="">All documents</option>
                    {docsWithNotes.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="secondary">
                  Show
                </button>
              </form>
              <p className="muted">Notes are private: only you see them. Edit or delete a note on its document.</p>
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
                      This document isn&apos;t in the source any more; its notes are kept.
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
                                <a href={docHref(n.docPath, at?.headingId)}>{title || "The whole document"}</a>
                              ) : (
                                n.headingId || "The whole document"
                              )}
                              {at?.status === "changed" ? (
                                <span
                                  className="badge warn"
                                  data-testid="text-changed"
                                  title="The document changed: the text this note quoted isn't in it any more."
                                >
                                  text changed
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
                              {issueHref(n.issueUrl) ? (
                                <a
                                  className="issue-link"
                                  href={issueHref(n.issueUrl)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  data-testid="issue-link"
                                >
                                  Issue created ✓
                                </a>
                              ) : null}
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
