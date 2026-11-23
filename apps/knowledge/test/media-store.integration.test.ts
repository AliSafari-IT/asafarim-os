/**
 * The S3 store against a real S3-compatible server (#359): MinIO in CI and in `pnpm dev`. Runs when
 * KNOWLEDGE_TEST_S3_URL is set, e.g. http://minioadmin:minioadmin@localhost:9000 (the keys as the URL's user info).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { s3Store } from "@/lib/media/store";

const RAW = process.env.KNOWLEDGE_TEST_S3_URL;

describe.skipIf(!RAW)("media store on S3-compatible storage", () => {
  const u = new URL(RAW ?? "http://localhost");
  const endpoint = `${u.protocol}//${u.host}`;
  const cfg = {
    endpoint,
    publicEndpoint: endpoint,
    bucket: `knowledge-test-${randomBytes(4).toString("hex")}`,
    region: "us-east-1",
    accessKeyId: decodeURIComponent(u.username),
    secretAccessKey: decodeURIComponent(u.password),
  };
  const store = s3Store(cfg);
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it("takes a presigned upload of exactly the size and type it was signed for", async () => {
    await store.createBucket();
    const key = "uploads/a b+c";
    const put = store.presignUpload(key, "image/png", PNG.byteLength);
    // A different size or type than signed is refused.
    expect((await fetch(put.url, { method: "PUT", headers: put.headers, body: Uint8Array.from([1, 2, 3]) })).ok).toBe(
      false,
    );
    expect((await fetch(put.url, { method: "PUT", headers: { "content-type": "text/html" }, body: PNG })).ok).toBe(
      false,
    );
    const res = await fetch(put.url, { method: "PUT", headers: put.headers, body: PNG });
    expect(res.status).toBe(200);

    expect(await store.head(key)).toEqual({ size: PNG.byteLength });
    expect(await store.readStart(key, 4)).toEqual(PNG.slice(0, 4));
    await store.copy(key, "assets/x");
    await store.remove(key);
    expect(await store.head(key)).toBeNull();
    const body = await store.open("assets/x");
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(PNG);
    expect(await store.open("assets/missing")).toBeNull();
    // The bucket is private: no unsigned read.
    expect((await fetch(`${endpoint}/${cfg.bucket}/assets/x`)).ok).toBe(false);
    await store.remove("assets/x");
    await store.remove("assets/x"); // removing twice is fine
  });
});
