/**
 * The studio home: the person's own articles (every article for an editor) and a form to start one.
 * The gateway asks for knowledge.content.create on /studio/**; requireStudio asks again.
 */
import { one, type SearchParams } from "@/lib/params";
import Link from "next/link";
import { createArticleAction } from "./actions";
import { Notices } from "@/components/Notices";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { listStudioItems } from "@/lib/content";
import { canCreateCourse, canManageTaxonomy, seesAll, seesAllCourses } from "@/lib/policy";
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
  const pool = await db();
  const query = (q ?? "").trim().slice(0, 200);
  // The studio's own search (#357): titles and slugs of the articles this person may see, drafts included.
  const found = query ? await searchStudio(pool, { subject: g.actor.subject, seesAll: seesAll(g.actor) }, query) : null;
  const page = found ? { items: [], next: null } : await listStudioItems(pool, g.actor, { after });
  const items = found
    ? found.map((f) => ({ id: f.id, status: f.status, updatedAt: f.updatedAt, draft: { title: f.title } }))
    : page.items;

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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager after={after} next={page.next} base="/studio" label="Older articles" />
          </section>

          <aside className="studio-side">
            <form action={createArticleAction} className="card studio-new" data-testid="new-article">
              <h2>New article</h2>
              <label>
                Title
                <input name="title" maxLength={200} required placeholder="A clear, specific title" />
              </label>
              <label>
                Slug <span className="muted">(optional; made from the title when empty)</span>
                <input name="slug" maxLength={96} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="my-article-slug" />
              </label>
              <label>
                Summary
                <textarea name="summary" rows={3} maxLength={500} placeholder="One or two sentences for readers" />
              </label>
              <button type="submit" data-testid="create">
                Create draft
              </button>
            </form>
          </aside>
        </div>
      </main>
    </>
  );
}
