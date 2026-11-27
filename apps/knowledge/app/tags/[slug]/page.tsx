import { cache } from "react";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Pager } from "@/components/Pager";
import { SearchResults } from "@/components/SearchResults";
import { db } from "@/lib/db";
import { searchPublished } from "@/lib/search";
import { publicTag } from "@/lib/public-tags";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ after?: string }> };
const loadTag = cache(async (slug: string) => publicTag(await db(), slug));

export async function generateMetadata({ params }: Props) {
  const tag = await loadTag((await params).slug);
  return tag ? { title: `Posts tagged “${tag.name}”` } : {};
}

export default async function TagPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const tag = await loadTag(slug);
  if (!tag) notFound();
  const { after } = await searchParams;
  const page = await searchPublished(await db(), { filters: { tag: slug }, after });
  const base = `/tags/${slug}`;
  return (
    <>
      <TopBar next={base} />
      <main>
        <h1>Posts tagged “{tag.name}”</h1>
        {page.items.length ? <SearchResults hits={page.items} /> : <p>No more posts for this tag.</p>}
        <Pager base={base} after={after} next={page.next} label="Older articles" />
      </main>
    </>
  );
}
