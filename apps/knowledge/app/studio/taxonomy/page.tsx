/**
 * Manage topics, tag kinds and aliases. Authors can also create subject tags on their articles.
 */
import Link from "next/link";
import { forbidden } from "next/navigation";
import { createTagAction, createTopicAction } from "../actions";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { canManageTaxonomy } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";
import { listTags, listTopics } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function TaxonomyPage({ searchParams }: Props) {
  const { error, done, detail } = await searchParams;
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio/taxonomy" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  if (!canManageTaxonomy(g.actor)) forbidden();
  const pool = await db();
  const [topics, tags] = await Promise.all([listTopics(pool), listTags(pool)]);
  const roots = topics.filter((t) => !t.parentId);
  return (
    <>
      <TopBar next="/studio/taxonomy" />
      <main className="wide taxonomy">
        <p>
          <Link href="/studio">← Studio</Link>
        </p>
        <h1>Topics and tags</h1>
        <Notices error={error} done={done} detail={detail} />

        <section className="card" data-testid="topics">
          <h2>Topics</h2>
          <ul>
            {roots.map((t) => (
              <li key={t.id}>
                <Link href={`/topics/${t.slug}`}>{t.name}</Link> <span className="muted">{t.slug}</span>
                <ul>
                  {topics
                    .filter((c) => c.parentId === t.id)
                    .map((c) => (
                      <li key={c.id}>
                        <Link href={`/topics/${c.slug}`}>{c.name}</Link> <span className="muted">{c.slug}</span>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
          <form action={createTopicAction} data-testid="new-topic">
            <h3>New topic</h3>
            <div className="facets">
              <label>
                Name
                <input name="name" maxLength={80} required />
              </label>
              <label>
                Slug
                <input name="slug" maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" required />
              </label>
              <label>
                Parent
                <select name="parent" defaultValue="">
                  <option value="">None (top level)</option>
                  {roots.map((t) => (
                    <option key={t.id} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Description
              <input name="description" maxLength={300} />
            </label>
            <button type="submit" className="secondary">
              Create topic
            </button>
          </form>
        </section>

        <section className="card" data-testid="tags">
          <h2>Tags</h2>
          <p>
            {tags.map((t) => (
              <span
                key={t.id}
                className="tag-chip"
                title={t.aliases.length ? `Also: ${t.aliases.join(", ")}` : undefined}
              >
                {t.name} <span className="muted">{t.kind === "technology" ? "· technology" : ""}</span>
              </span>
            ))}
          </p>
          <form action={createTagAction} data-testid="new-tag">
            <h3>New tag</h3>
            <div className="facets">
              <label>
                Name
                <input name="name" maxLength={60} required />
              </label>
              <label>
                Slug
                <input name="slug" maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" required />
              </label>
              <label>
                Kind
                <select name="kind" defaultValue="subject">
                  <option value="subject">Subject</option>
                  <option value="technology">Technology (a search facet)</option>
                </select>
              </label>
            </div>
            <label>
              Aliases <span className="muted">(comma-separated other spellings, e.g. js, ecmascript)</span>
              <input name="aliases" />
            </label>
            <button type="submit" className="secondary">
              Create tag
            </button>
          </form>
        </section>
      </main>
    </>
  );
}
