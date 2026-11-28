/**
 * The person's uploaded media (#359): what they uploaded, how many revisions use each file, and deleting what no
 * revision uses. Uploading here is the same direct upload as in the editor.
 */
import Link from "next/link";
import { deleteMediaAction } from "../media-actions";
import { MediaUpload } from "@/components/MediaUpload";
import { Notices } from "@/components/Notices";
import { Pager } from "@/components/Pager";
import { StudioTabs } from "@/components/StudioTabs";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { listLibrary } from "@/lib/media/assets";
import { mediaConfigFromEnv } from "@/lib/media/store";
import { one, type SearchParams } from "@/lib/params";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

const size = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export default async function StudioMedia({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const g = await requireStudio();
  const sp = await searchParams;
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio/media" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const on = mediaConfigFromEnv() !== null;
  const after = one(sp.after);
  const assets = on ? await listLibrary(await db(), g.actor, { after }) : { items: [], next: null };
  return (
    <>
      <TopBar next="/studio/media" />
      <main>
        <p>
          <Link href="/studio">← Studio</Link>
        </p>
        <h1>Media</h1>
        <StudioTabs actor={g.actor} current="media" />
        <Notices error={one(sp.error)} done={one(sp.done)} />
        {!on ? (
          <p className="muted" data-testid="media-off">
            Uploads aren&apos;t set up on this server yet. Videos can still be embedded from the editor.
          </p>
        ) : (
          <>
            <MediaUpload />
            {assets.items.length === 0 && !after ? (
              <p className="muted" data-testid="media-empty">
                No uploads yet.
              </p>
            ) : (
              <ul className="media-list" data-testid="media-list">
                {assets.items.map((a) => (
                  <li key={a.id} data-testid="media-item">
                    {a.kind === "image" ? <img src={`/media/${a.id}`} alt="" loading="lazy" /> : null}
                    <div>
                      <a href={`/media/${a.id}`}>{a.filename}</a>
                    </div>
                    <div className="muted">
                      {size(a.byteSize)} ·{" "}
                      {a.uses ? `used by ${a.uses} revision${a.uses === 1 ? "" : "s"}` : "not used yet"}
                    </div>
                    {a.uses === 0 ? (
                      <form action={deleteMediaAction} className="inline">
                        <input type="hidden" name="id" value={a.id} />
                        <button type="submit" className="secondary danger">
                          Delete
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <Pager after={after} next={assets.next} base="/studio/media" label="Older uploads" />
          </>
        )}
      </main>
    </>
  );
}
