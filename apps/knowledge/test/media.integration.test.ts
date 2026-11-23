/**
 * Media on a real PostgreSQL (#359), with an in-memory store standing in for MinIO: the upload handshake and its
 * quarantine, who may use and read an asset, public exactly while a public revision uses it, deletion and cleanup.
 * Runs when KNOWLEDGE_TEST_DATABASE_URL names a server where it may create a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { autosaveDraft, createArticle, publishRevision, saveDraft, withdrawArticle } from "../lib/content";
import { createCourse, editCourse, publishCourse } from "../lib/courses";
import { parseDoc, type Doc } from "../lib/doc";
import {
  assetKey,
  cleanupMedia,
  deleteAsset,
  finishUpload,
  listLibrary,
  MAX_PENDING,
  readableAsset,
  requestUpload,
  uploadKey,
} from "../lib/media/assets";
import { memoryStore } from "../lib/media/store";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };
const erin: Actor = { subject: "erin", permissions: grants("knowledge.editor") };
const reader: Actor = { subject: "rita", permissions: [] };

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.7\n% a tiny file\n");

const docWith = (...nodes: object[]): Doc => {
  const r = parseDoc({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }, ...nodes],
  });
  if (!r.ok) throw new Error(r.error);
  return r.doc;
};
const image = (asset: string, alt = "A diagram of the flow") => ({ type: "image", attrs: { asset, alt, caption: "" } });
const file = (asset: string) => ({ type: "attachment", attrs: { asset, label: "The slides" } });
const draft = (doc: Doc) => ({ title: "With media", summary: "", body: "Hi", doc });

describe.skipIf(!ADMIN_URL)("media on PostgreSQL", () => {
  const dbName = `knowledge_media_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  const store = memoryStore();

  /** The whole handshake, with `bytes` as what the browser actually sent. */
  async function upload(actor: Actor, bytes: Uint8Array, contentType = "image/png", size = bytes.byteLength) {
    const t = ok(await requestUpload(pool, store, actor, { contentType, size, filename: "pic.png" }));
    store.objects.set(uploadKey(t.id), bytes);
    return { id: t.id, done: await finishUpload(pool, store, actor, t.id) };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    pool.on("error", () => undefined);
    const c = await pool.connect();
    try {
      await migrate(c);
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("accepts an upload only after checking what arrived, and never serves quarantine", async () => {
    const t = ok(
      await requestUpload(pool, store, alice, {
        contentType: "image/png",
        size: PNG.byteLength,
        filename: "a/b/pic.png",
      }),
    );
    // Nothing arrived yet: still pending, and not readable by anyone.
    expect(await finishUpload(pool, store, alice, t.id)).toEqual({ ok: false, error: "media_not_uploaded" });
    expect(await readableAsset(pool, alice, t.id)).toBeNull();
    store.objects.set(uploadKey(t.id), PNG);
    // Only the uploader finishes it.
    expect(await finishUpload(pool, store, bob, t.id)).toEqual({ ok: false, error: "not_found" });
    const done = ok(await finishUpload(pool, store, alice, t.id));
    expect([done.asset.status, done.asset.filename, done.asset.kind]).toEqual(["ready", "pic.png", "image"]);
    expect(store.objects.has(uploadKey(t.id))).toBe(false);
    expect(store.objects.get(assetKey(t.id))).toEqual(PNG);
  });

  it("rejects a file whose bytes or size don't match what was asked for, and removes it", async () => {
    const lying = await upload(alice, new TextEncoder().encode("<svg onload=alert(1)>"));
    expect(lying.done).toEqual({ ok: false, error: "media_rejected" });
    expect(store.objects.has(uploadKey(lying.id))).toBe(false);
    expect(store.objects.has(assetKey(lying.id))).toBe(false);
    const short = await upload(alice, PNG, "image/png", PNG.byteLength + 10);
    expect(short.done).toEqual({ ok: false, error: "media_rejected" });
    expect(await readableAsset(pool, alice, short.id)).toBeNull();
  });

  it("refuses types, sizes and people before anything is stored", async () => {
    const ask = (actor: Actor, contentType: string, size: number) =>
      requestUpload(pool, store, actor, { contentType, size, filename: "x" });
    expect(await ask(alice, "image/svg+xml", 10)).toEqual({ ok: false, error: "media_type" });
    expect(await ask(alice, "text/html", 10)).toEqual({ ok: false, error: "media_type" });
    expect(await ask(alice, "image/png", 11 * 1024 * 1024)).toEqual({ ok: false, error: "media_too_large" });
    expect(await ask(alice, "application/pdf", 0)).toEqual({ ok: false, error: "media_empty" });
    expect(await ask(reader, "image/png", 10)).toEqual({ ok: false, error: "forbidden" });
    // A flood of unfinished uploads stops at the cap.
    for (let i = 0; i < MAX_PENDING; i++) ok(await ask(bob, "image/png", 10));
    expect(await ask(bob, "image/png", 10)).toEqual({ ok: false, error: "media_too_many_pending" });
  });

  it("keeps draft media private, makes it public while published, and private again when withdrawn", async () => {
    const { id } = await upload(alice, PNG);
    const pdf = ok((await upload(alice, PDF, "application/pdf")).done).asset.id;
    // Before any revision uses it: only its uploader and someone who sees everything.
    expect((await readableAsset(pool, alice, id))?.isPublic).toBe(false);
    expect(await readableAsset(pool, null, id)).toBeNull();
    expect(await readableAsset(pool, bob, id)).toBeNull();
    expect((await readableAsset(pool, erin, id))?.isPublic).toBe(false);

    const a = ok(await createArticle(pool, alice, { slug: "with-media", draft: draft(docWith(image(id), file(pdf))) }));
    expect(await readableAsset(pool, null, id)).toBeNull();
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect((await readableAsset(pool, null, id))?.isPublic).toBe(true);
    expect((await readableAsset(pool, bob, pdf))?.isPublic).toBe(true);
    // A new draft without the image doesn't change the public revision...
    const v2 = ok(
      await saveDraft(pool, alice, { id: a.id, expectedRevisionId: a.revisionId, draft: draft(docWith()) }),
    );
    expect((await readableAsset(pool, null, id))?.isPublic).toBe(true);
    // ...withdrawing does, at once.
    ok(await withdrawArticle(pool, alice, { id: a.id }));
    expect(await readableAsset(pool, null, id)).toBeNull();
    // Publishing the revision without the image keeps it private.
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: v2.revisionId }));
    expect(await readableAsset(pool, null, id)).toBeNull();
    // A published course whose lesson pins the old revision would show it again: but a lesson can only pin the
    // article's current published revision, so that needs the image back in a published revision first.
    const v3 = ok(
      await saveDraft(pool, alice, { id: a.id, expectedRevisionId: v2.revisionId, draft: draft(docWith(image(id))) }),
    );
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: v3.revisionId }));
    const c = ok(await createCourse(pool, alice, { slug: "media-course", title: "Media course" }));
    let rev = ok(
      await editCourse(pool, alice, {
        id: c.id,
        expectedRevisionId: c.revisionId,
        edit: { op: "add_module", title: "One" },
      }),
    ).revisionId;
    rev = ok(
      await editCourse(pool, alice, {
        id: c.id,
        expectedRevisionId: rev,
        edit: { op: "add_lesson", module: 0, articleSlug: "with-media" },
      }),
    ).revisionId;
    ok(await publishCourse(pool, alice, { id: c.id, revisionId: rev, publication: 0 }));
    // The article moves on to a revision without the image; the course still shows the one it pinned.
    const v4 = ok(
      await saveDraft(pool, alice, { id: a.id, expectedRevisionId: v3.revisionId, draft: draft(docWith()) }),
    );
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: v4.revisionId }));
    expect((await readableAsset(pool, null, id))?.isPublic).toBe(true);
  });

  it("only lets a revision use ready media its author may use, of the right kind", async () => {
    const mine = (await upload(alice, PNG)).id;
    const pdf = ok((await upload(alice, PDF, "application/pdf")).done).asset.id;
    const pending = ok(
      await requestUpload(pool, store, alice, { contentType: "image/png", size: 10, filename: "p" }),
    ).id;
    const refused = { ok: false, error: "media_unavailable" };
    // Someone else's image, a PDF as an image, an unfinished upload, an id that isn't an asset.
    expect(await createArticle(pool, bob, { slug: "bobs", draft: draft(docWith(image(mine))) })).toEqual(refused);
    expect(await createArticle(pool, alice, { slug: "pdf-img", draft: draft(docWith(image(pdf))) })).toEqual(refused);
    expect(await createArticle(pool, alice, { slug: "pending", draft: draft(docWith(image(pending))) })).toEqual(
      refused,
    );
    expect(
      await createArticle(pool, alice, {
        slug: "ghost",
        draft: draft(docWith(image("00000000-0000-4000-8000-000000000000"))),
      }),
    ).toEqual(refused);
    // Nothing was written by a refused create.
    expect(
      (await pool.query("SELECT 1 FROM content_items WHERE slug IN ('bobs', 'pdf-img', 'pending', 'ghost')")).rowCount,
    ).toBe(0);

    // An editor may put their own image into Alice's article; Alice may then read it, and keep it when she saves.
    const a = ok(await createArticle(pool, alice, { slug: "shared", draft: draft(docWith()) }));
    const erins = (await upload(erin, PNG)).id;
    expect(await readableAsset(pool, alice, erins)).toBeNull();
    const r2 = ok(
      await saveDraft(pool, erin, { id: a.id, expectedRevisionId: a.revisionId, draft: draft(docWith(image(erins))) }),
    );
    expect((await readableAsset(pool, alice, erins))?.isPublic).toBe(false);
    expect(await readableAsset(pool, bob, erins)).toBeNull();
    ok(
      await saveDraft(pool, alice, {
        id: a.id,
        expectedRevisionId: r2.revisionId,
        draft: draft(docWith(image(erins, "Now described"))),
      }),
    );
  });

  it("deletes only unused media, and cleanup removes what nobody will use", async () => {
    const used = (await upload(alice, PNG)).id;
    const unused = (await upload(alice, PNG)).id;
    const autosaved = (await upload(alice, PNG)).id;
    const a = ok(await createArticle(pool, alice, { slug: "cleanup", draft: draft(docWith(image(used))) }));
    ok(
      await autosaveDraft(pool, alice, {
        id: a.id,
        baseRevisionId: a.revisionId,
        draft: draft(docWith(image(used), image(autosaved))),
      }),
    );
    expect(await deleteAsset(pool, store, alice, used)).toEqual({ ok: false, error: "media_in_use" });
    expect(await deleteAsset(pool, store, bob, unused)).toEqual({ ok: false, error: "not_found" });
    expect((await listLibrary(pool, alice)).find((x) => x.id === used)?.uses).toBe(1);

    const stale = ok(await requestUpload(pool, store, alice, { contentType: "image/png", size: 10, filename: "s" })).id;
    store.objects.set(uploadKey(stale), PNG);
    // Too young for cleanup today...
    await cleanupMedia(pool, store);
    expect(await readableAsset(pool, alice, unused)).not.toBeNull();
    // ...but in eight days: the unfinished upload and the unused asset go; the used and the autosaved stay.
    const later = new Date(Date.now() + 8 * 24 * 3600_000);
    await cleanupMedia(pool, store, later);
    const left = (
      await pool.query<{ id: string }>("SELECT id FROM media_assets WHERE id = ANY($1)", [
        [used, unused, autosaved, stale],
      ])
    ).rows.map((r) => r.id);
    expect(left.sort()).toEqual([used, autosaved].sort());
    expect(store.objects.has(assetKey(unused))).toBe(false);
    expect(store.objects.has(uploadKey(stale))).toBe(false);
    expect(store.objects.has(assetKey(used))).toBe(true);

    const gone = (await upload(alice, PNG)).id;
    ok(await deleteAsset(pool, store, alice, gone));
    expect(store.objects.has(assetKey(gone))).toBe(false);
    expect(await readableAsset(pool, alice, gone)).toBeNull();
  });
});
