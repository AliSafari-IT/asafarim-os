/**
 * A topic page (#357): the topic, its subtopics and the published articles in it (and in its subtopics), newest
 * first, from the search projection. An unknown topic is a 404.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SearchResults } from "@/components/SearchResults";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { searchPublished } from "@/lib/search";
import { getTopic, listTopics } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const topic = await getTopic(await db(), (await params).slug);
  return topic ? { title: topic.name, description: topic.description || undefined } : {};
}

export default async function TopicPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { after } = await searchParams;
  const pool = await db();
  const topic = await getTopic(pool, slug);
  if (!topic) notFound();
  const all = await listTopics(pool);
  const parent = topic.parentId ? all.find((t) => t.id === topic.parentId) : null;
  const children = all.filter((t) => t.parentId === topic.id);
  const page = await searchPublished(pool, { filters: { topic: topic.slug }, after });
  return (
    <>
      <TopBar next={`/topics/${slug}`} />
      <main>
        {parent ? (
          <p>
            <Link href={`/topics/${parent.slug}`}>← {parent.name}</Link>
          </p>
        ) : null}
        <h1 data-testid="topic-name">{topic.name}</h1>
        {topic.description ? <p className="lead">{topic.description}</p> : null}
        {children.length ? (
          <p data-testid="subtopics">
            {children.map((c, i) => (
              <span key={c.id}>
                {i ? " · " : ""}
                <Link href={`/topics/${c.slug}`}>{c.name}</Link>
              </span>
            ))}
          </p>
        ) : null}
        {page.items.length ? (
          <SearchResults hits={page.items} />
        ) : (
          <p className="muted" data-testid="empty">
            Nothing is published in this topic yet.
          </p>
        )}
        <Pager after={after} next={page.next} base={`/topics/${slug}`} label="Older articles" />
      </main>
    </>
  );
}
