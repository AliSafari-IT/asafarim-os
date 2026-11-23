import { describe, expect, it } from "vitest";
import { presign, signHeaders, uriEncode } from "@/lib/media/sigv4";

/** The worked examples of AWS's "Signature Version 4" pages for S3 (examplebucket, 24 May 2013). */
const creds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
const at = new Date("2013-05-24T00:00:00Z");

describe("SigV4 (#359)", () => {
  it("presigns a GET exactly as AWS's query-string example", () => {
    const url = presign(creds, {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      expiresSeconds: 86400,
      at,
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs a ranged GET exactly as AWS's header example", () => {
    const h = signHeaders(creds, {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      at,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("encodes like RFC 3986, keeping slashes only in paths", () => {
    expect(uriEncode("a b/c~d*é")).toBe("a%20b%2Fc~d%2A%C3%A9");
    expect(uriEncode("/bucket/a b", true)).toBe("/bucket/a%20b");
  });
});
