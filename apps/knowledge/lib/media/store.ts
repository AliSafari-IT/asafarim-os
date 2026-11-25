/**
 * Where uploaded media lives (#359): one private bucket on an S3-compatible store on the VPS (Garage in dev and CI). The bucket is
 * never public. A browser only ever gets a short presigned PUT for one new object under `uploads/`, and reads go
 * through the app (/media/:id), which checks who may see the asset first.
 *
 * Off unless KNOWLEDGE_MEDIA_ENDPOINT, KNOWLEDGE_MEDIA_ACCESS_KEY and KNOWLEDGE_MEDIA_SECRET_KEY are set: then the
 * studio offers no uploads, and everything else works as before.
 */
import { presign, signHeaders, uriEncode, type Credentials } from "./sigv4";

export interface ObjectInfo {
  size: number;
}

export interface MediaStore {
  /** A presigned PUT for `key`: the browser must send exactly `headers`. */
  presignUpload(key: string, contentType: string, size: number): { url: string; headers: Record<string, string> };
  head(key: string): Promise<ObjectInfo | null>;
  /** The first `n` bytes (fewer when the object is smaller). */
  readStart(key: string, n: number): Promise<Uint8Array>;
  copy(from: string, to: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** The object's bytes as a stream, or null when it is missing. */
  open(key: string): Promise<ReadableStream<Uint8Array> | null>;
}

export interface S3Config extends Credentials {
  /** Where the server reaches the store (e.g. http://os-media:3900 in production). */
  endpoint: string;
  /** Where browsers reach it for uploads (https://media.learn.asafarim.site); the endpoint when not set. */
  publicEndpoint: string;
  bucket: string;
}

export const UPLOAD_URL_SECONDS = 600;

export function mediaConfigFromEnv(env: Record<string, string | undefined> = process.env): S3Config | null {
  const endpoint = env.KNOWLEDGE_MEDIA_ENDPOINT?.trim();
  const accessKeyId = env.KNOWLEDGE_MEDIA_ACCESS_KEY?.trim();
  const secretAccessKey = env.KNOWLEDGE_MEDIA_SECRET_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    publicEndpoint: (env.KNOWLEDGE_MEDIA_PUBLIC_ENDPOINT?.trim() || endpoint).replace(/\/+$/, ""),
    bucket: env.KNOWLEDGE_MEDIA_BUCKET?.trim() || "knowledge-media",
    region: env.KNOWLEDGE_MEDIA_REGION?.trim() || "us-east-1",
    accessKeyId,
    secretAccessKey,
  };
}

class StoreError extends Error {}

export function s3Store(
  cfg: S3Config,
  fetchImpl: typeof fetch = fetch,
): MediaStore & { createBucket(): Promise<void> } {
  const url = (base: string, key?: string, query = "") =>
    new URL(`${base}/${uriEncode(cfg.bucket)}${key === undefined ? "" : `/${uriEncode(key, true)}`}${query}`);

  async function call(method: string, target: URL, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetchImpl(target, {
      method,
      headers: signHeaders(cfg, { method, url: target, headers }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    return res;
  }

  const fail = async (what: string, res: Response): Promise<never> => {
    await res.body?.cancel().catch(() => undefined);
    throw new StoreError(`media store: ${what} answered ${res.status}`);
  };

  return {
    presignUpload(key, contentType, size) {
      const headers = { "content-type": contentType, "content-length": String(size) };
      return {
        url: presign(cfg, {
          method: "PUT",
          url: url(cfg.publicEndpoint, key),
          headers,
          expiresSeconds: UPLOAD_URL_SECONDS,
        }),
        headers: { "content-type": contentType },
      };
    },
    async head(key) {
      const res = await call("HEAD", url(cfg.endpoint, key));
      if (res.status === 404) return null;
      if (!res.ok) return fail("HEAD", res);
      return { size: Number(res.headers.get("content-length") ?? "0") };
    },
    async readStart(key, n) {
      const res = await call("GET", url(cfg.endpoint, key), { range: `bytes=0-${n - 1}` });
      if (!res.ok) return fail("GET (range)", res);
      return new Uint8Array(await res.arrayBuffer()).slice(0, n);
    },
    async copy(from, to) {
      const res = await call("PUT", url(cfg.endpoint, to), {
        "x-amz-copy-source": `/${uriEncode(cfg.bucket)}/${uriEncode(from, true)}`,
      });
      // S3 can answer 200 with an error document for a failed copy.
      const text = await res.text();
      if (!res.ok || text.includes("<Error>")) throw new StoreError(`media store: copy answered ${res.status}`);
    },
    async remove(key) {
      const res = await call("DELETE", url(cfg.endpoint, key));
      if (!res.ok && res.status !== 404) return fail("DELETE", res);
      await res.body?.cancel().catch(() => undefined);
    },
    async open(key) {
      const res = await call("GET", url(cfg.endpoint, key));
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok || !res.body) return fail("GET", res);
      return res.body;
    },
    async createBucket() {
      const res = await call("PUT", url(cfg.endpoint));
      if (!res.ok && res.status !== 409) return fail("PUT bucket", res);
      await res.body?.cancel().catch(() => undefined);
    },
  };
}

let cached: { store: MediaStore | null } | undefined;

/** The configured store, or null when media is off. */
export function getMediaStore(): MediaStore | null {
  if (!cached) {
    const cfg = mediaConfigFromEnv();
    cached = { store: cfg ? s3Store(cfg) : null };
  }
  return cached.store;
}

/** An in-memory store for tests. */
export function memoryStore(): MediaStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    presignUpload(key, contentType) {
      return { url: `memory://upload/${key}`, headers: { "content-type": contentType } };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.byteLength } : null;
    },
    async readStart(key, n) {
      const o = objects.get(key);
      if (!o) throw new StoreError("missing");
      return o.slice(0, n);
    },
    async copy(from, to) {
      const o = objects.get(from);
      if (!o) throw new StoreError("missing");
      objects.set(to, o);
    },
    async remove(key) {
      objects.delete(key);
    },
    async open(key) {
      const o = objects.get(key);
      if (!o) return null;
      return new ReadableStream({
        start(c) {
          c.enqueue(o);
          c.close();
        },
      });
    },
  };
}
