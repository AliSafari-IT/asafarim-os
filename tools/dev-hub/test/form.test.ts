import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FormTooLargeError, MAX_FORM_BYTES, readForm } from "../src/server.ts";

describe("dev hub form reading", () => {
  it("parses a small form", async () => {
    const form = await readForm(Readable.from([Buffer.from("ticket=abc&sub=dev-member")]));
    expect(form.get("sub")).toBe("dev-member");
  });

  it("counts bytes, not characters: multibyte content over the limit is refused", async () => {
    const body = "é".repeat(MAX_FORM_BYTES); // 1 character = 2 bytes
    expect(body.length).toBeLessThanOrEqual(MAX_FORM_BYTES);
    await expect(readForm(Readable.from([Buffer.from(body)]))).rejects.toBeInstanceOf(FormTooLargeError);
  });

  it("refuses a body that crosses the limit mid-stream, after draining all of it", async () => {
    let consumed = 0;
    async function* chunks() {
      for (let i = 0; i < 10; i++) {
        consumed++;
        yield Buffer.alloc(MAX_FORM_BYTES / 4);
      }
    }
    await expect(readForm(chunks())).rejects.toBeInstanceOf(FormTooLargeError);
    expect(consumed).toBe(10); // drained, so the socket survives long enough to answer 413
  });
});
