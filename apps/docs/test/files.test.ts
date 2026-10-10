import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serveImage } from "../lib/files";
import type { GateResult } from "../lib/gate";
import { createFixtureBackend, createSource, createUnavailableBackend } from "../lib/source";

const source = createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));
const allowed = async (): Promise<GateResult> => ({ ok: true, subject: "owner", roles: ["docs.owner"] });

describe("the image route (#78)", () => {
  it("checks the permission first: no read at all without it", async () => {
    const read = vi.spyOn(source, "readImage");
    for (const refusal of [
      { ok: false, status: 401, body: { error: "unauthenticated", message: "Sign in first." } },
      { ok: false, status: 403, body: { error: "forbidden", permission: "docs.read", message: "Forbidden" } },
      { ok: false, status: 503, body: { error: "app_inactive", state: "inactive", message: "inactive" } },
    ] as const) {
      const res = await serveImage("images/diagram.svg", { gate: async () => refusal, source: () => source });
      expect(res.status).toBe(refusal.status);
      expect(await res.json()).toMatchObject({ error: refusal.body.error });
    }
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("serves an image of the listing with its type; an SVG can't run script", async () => {
    const res = await serveImage("images/diagram.svg", { gate: allowed, source: () => source });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toContain("<svg");
  });

  it("a document, an unknown file or a path escape is 404", async () => {
    for (const p of ["index.md", "images/nope.png", "../package.json", "images/../index.md"]) {
      expect((await serveImage(p, { gate: allowed, source: () => source })).status, p).toBe(404);
    }
  });

  it("the source unavailable is 503", async () => {
    const down = createSource(createUnavailableBackend("GitHub isn't reachable"));
    const res = await serveImage("images/diagram.svg", { gate: allowed, source: () => down });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "source_unavailable" });
  });
});
