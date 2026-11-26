/**
 * AWS Signature Version 4 for an S3-compatible store (#359): presigned URLs for the browser's direct upload, and
 * signed headers for the server's own requests. Path-style addressing (`<endpoint>/<bucket>/<key>`), which MinIO and Garage
 * serve without per-bucket DNS. No SDK: the signing is small, and test/sigv4.test.ts checks it against the worked
 * examples in AWS's S3 documentation.
 */
import { createHash, createHmac } from "node:crypto";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding, as SigV4 wants it: everything but unreserved characters, and `/` kept in paths. */
export function uriEncode(s: string, keepSlash = false): string {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** "20130524T000000Z" */
export const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

function signingKey(c: Credentials, date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), c.region), "s3"), "aws4_request");
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k]!)}`)
    .join("&");
}

interface Canonical {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Lower-case names. */
  headers: Record<string, string>;
  payloadHash: string;
}

function sign(c: Credentials, at: Date, req: Canonical): { signature: string; signedHeaders: string; scope: string } {
  const names = Object.keys(req.headers).sort();
  const signedHeaders = names.join(";");
  const canonical = [
    req.method,
    uriEncode(req.path, true),
    canonicalQuery(req.query),
    names.map((n) => `${n}:${req.headers[n]!.trim().replace(/\s+/g, " ")}\n`).join(""),
    signedHeaders,
    req.payloadHash,
  ].join("\n");
  const date = amzDate(at).slice(0, 8);
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate(at), scope, sha256(canonical)].join("\n");
  return { signature: hmac(signingKey(c, date), toSign).toString("hex"), signedHeaders, scope };
}

/**
 * A presigned URL: the request it allows is fixed by `method`, the path, and every header in `headers` (which the
 * caller must then send with exactly these values). Valid for `expiresSeconds`.
 */
export function presign(
  c: Credentials,
  input: {
    method: "GET" | "PUT";
    url: URL;
    headers?: Record<string, string>;
    expiresSeconds: number;
    at?: Date;
  },
): string {
  const at = input.at ?? new Date();
  const headers: Record<string, string> = { host: input.url.host };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  const date = amzDate(at).slice(0, 8);
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.accessKeyId}/${date}/${c.region}/s3/aws4_request`,
    "X-Amz-Date": amzDate(at),
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": Object.keys(headers).sort().join(";"),
  };
  const { signature } = sign(c, at, {
    method: input.method,
    path: decodeURIComponent(input.url.pathname),
    query,
    headers,
    payloadHash: "UNSIGNED-PAYLOAD",
  });
  return `${input.url.origin}${uriEncode(decodeURIComponent(input.url.pathname), true)}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/** The headers that sign a server-side request (body hash given, or the empty body's). */
export function signHeaders(
  c: Credentials,
  input: {
    method: string;
    url: URL;
    headers?: Record<string, string>;
    payloadHash?: string;
    at?: Date;
  },
): Record<string, string> {
  const at = input.at ?? new Date();
  const payloadHash = input.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-date": amzDate(at),
    "x-amz-content-sha256": payloadHash,
  };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  const query: Record<string, string> = {};
  input.url.searchParams.forEach((v, k) => (query[k] = v));
  const { signature, signedHeaders, scope } = sign(c, at, {
    method: input.method,
    path: decodeURIComponent(input.url.pathname),
    query,
    headers,
    payloadHash,
  });
  const out = { ...headers };
  delete (out as Record<string, string | undefined>).host;
  return {
    ...out,
    authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
