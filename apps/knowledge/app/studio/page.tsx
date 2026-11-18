/**
 * The studio home: the person's own articles (every article for an editor) and a form to start one.
 * The gateway asks for knowledge.content.create on /studio/**; requireStudio asks again.
 */
import Link from "next/link";
import { createArticleAction } from "./actions";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { listStudioItems } from "@/lib/content";
import { db } from "@/lib/db";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function Studio({ searchParams }: Props) {
  const g = await requireStudio();
  const { error, done } = await searchParams;
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
  const items = await listStudioItems(await db(), g.actor);

  return (
    <>
      <TopBar next="/studio" />
      <main>
        <h1>Studio</h1>
        <Notices error={error} done={done} />

        <form action={createArticleAction} className="card" data-testid="new-article">
          <h2>New article</h2>
          <label>
            Title
            <input name="title" maxLength={200} required />
          </label>
          <label>
            Slug <span className="muted">(optional; made from the title when empty)</span>
            <input name="slug" maxLength={96} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </label>
          <label>
            Summary
            <textarea name="summary" rows={2} maxLength={500} />
          </label>
          <button type="submit" data-testid="create">
            Create draft
          </button>
        </form>

        {items.length === 0 ? (
          <p className="muted" data-testid="studio-empty">
            No articles yet.
          </p>
        ) : (
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
                  <td>
                    <Link href={`/studio/content/${i.id}`}>{i.draft.title}</Link>
                  </td>
                  <td>
                    <span className={`badge ${i.status}`}>{i.status}</span>
                  </td>
                  <td className="muted">{i.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
