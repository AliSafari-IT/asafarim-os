/**
 * The studio home: the person's own articles (every article for an editor) and a form to start one.
 * The gateway asks for knowledge.content.create on /studio/**; requireStudio asks again.
 */
import { one, type SearchParams } from "@/lib/params";
import Link from "next/link";
import { Suspense } from "react";
import { createArticleAction } from "./actions";
import { NewArticleForm } from "@/components/NewArticleForm";
import { Notices } from "@/components/Notices";
import { Pager } from "@/components/Pager";
import { RowMenu } from "@/components/RowMenu";
import { TopBar } from "@/components/TopBar";
import { listStudioItems } from "@/lib/content";
import { canCreateCourse, canManageTaxonomy, seesAll, seesAllCourses, type Actor } from "@/lib/policy";
import { searchStudio } from "@/lib/search";
import { db } from "@/lib/db";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

// "Nov 26, 22:45" (UTC, like the revision times elsewhere in the studio).
const STUDIO_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

type Props = { searchParams: Promise<SearchParams> };

export default async function Studio({ searchParams }: Props) {
  const g = await requireStudio();
  const sp = await searchParams;
  const [error, done, after, q] = [one(sp.error), one(sp.done), one(sp.after), one(sp.q)];
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const query = (q ?? "").trim().slice(0, 200);

  return (
    <>
      <TopBar next="/studio" />
      <main className="studio">
        <header className="studio-head">
          <h1>Studio</h1>
          <p className="muted">Write, edit and publish your articles.</p>
        </header>
        <Notices error={error} done={done} />
        <nav className="studio-tabs" aria-label="Studio sections">
          <Link href="/studio" aria-current="page">
            Articles
          </Link>
          <Link href="/studio/media" data-testid="media-link">
            Media
          </Link>
          {canCreateCourse(g.actor) || seesAllCourses(g.actor) ? (
            <Link href="/studio/courses" data-testid="courses-link">
              Courses
            </Link>
          ) : null}
          {canManageTaxonomy(g.actor) ? (
            <Link href="/studio/taxonomy" data-testid="taxonomy-link">
              Topics and tags
            </Link>
          ) : null}
        </nav>

        <div className="studio-grid">
          <section className="studio-main" aria-label="Your articles">
            <form action="/studio" method="get" className="studio-search" role="search" data-testid="studio-search">
              <label className="visually-hidden" htmlFor="studio-q">
                Find your articles (drafts included; only in the studio)
              </label>
              <input
                id="studio-q"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={200}
                placeholder="Search your articles"
              />
              <button type="submit" className="secondary">
                Find
              </button>
              {query ? <Link href="/studio">Show all</Link> : null}
            </form>

            {/* The list streams in behind a skeleton; the page around it is already there. */}
            <Suspense key={`${query}|${after ?? ""}`} fallback={<StudioListSkeleton />}>
              <StudioList actor={g.actor} query={query} after={after} />
            </Suspense>
          </section>

          <aside className="studio-side">
            <NewArticleForm action={createArticleAction} />
          </aside>
        </div>
      </main>
    </>
  );
}

async function StudioList({ actor, query, after }: { actor: Actor; query: string; after: string | undefined }) {
  const pool = await db();
  // The studio's own search (#357): titles and slugs of the articles this person may see, drafts included.
  const found = query ? await searchStudio(pool, { subject: actor.subject, seesAll: seesAll(actor) }, query) : null;
  const page = found ? { items: [], next: null } : await listStudioItems(pool, actor, { after });
  const items = found
    ? found.map((f) => ({
        id: f.id,
        slug: f.slug,
        status: f.status,
        updatedAt: f.updatedAt,
        draft: { title: f.title },
      }))
    : page.items;

  return (
    <>
      {items.length === 0 && query ? (
        <p className="studio-empty muted" data-testid="studio-no-match">
          None of your articles matches that.
        </p>
      ) : items.length === 0 && !after ? (
        <p className="studio-empty muted" data-testid="studio-empty">
          No articles yet.
        </p>
      ) : (
        <div className="table-wrap studio-table">
          <table className="studio-list" data-testid="studio-items">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
                <th scope="col" className="studio-actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} data-testid="studio-item">
                  <td className="studio-title">
                    <Link href={`/studio/content/${i.id}`}>{i.draft.title}</Link>
                  </td>
                  <td>
                    <span className={`badge ${i.status}`}>{i.status}</span>
                  </td>
                  <td className="muted">
                    <time
                      dateTime={i.updatedAt.toISOString()}
                      title={`${i.updatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
                    >
                      {STUDIO_DATE.format(i.updatedAt)}
                    </time>
                  </td>
                  <td className="studio-actions">
                    <RowMenu
                      title={i.draft.title}
                      links={[
                        { href: `/studio/content/${i.id}`, label: "Edit" },
                        { href: `/studio/content/${i.id}/preview`, label: "Preview" },
                        ...(i.status === "published"
                          ? [{ href: `/articles/${i.slug}`, label: "View public page" }]
                          : []),
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager after={after} next={page.next} base="/studio" label="Older articles" />
    </>
  );
}

/** What shows while the list loads: four quiet rows in the table's own frame. */
function StudioListSkeleton() {
  return (
    <div className="studio-table studio-skeleton" role="status" aria-busy="true" data-testid="studio-loading">
      <span className="visually-hidden">Loading your articles…</span>
      {[0, 1, 2, 3].map((n) => (
        <div className="skeleton-row" key={n} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
