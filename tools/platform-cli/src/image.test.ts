import { describe, expect, it } from "vitest";
import { FIXTURE_MANIFEST, fakeDocker } from "./fake-docker.ts";
import { MANIFEST_LABEL, isImageRef, readImageManifest } from "./image.ts";

const REF = "ghcr.io/example/ext-demo:1.0.0";

describe("reading an external app's manifest from its image (#87)", () => {
  it("label present and valid: the manifest, without pulling an image that's already here", () => {
    const run = fakeDocker({ local: { [REF]: { [MANIFEST_LABEL]: FIXTURE_MANIFEST, other: "x" } } });
    const r = readImageManifest(REF, run);
    expect(r.ok && r.manifest.id).toBe("ext-demo");
    expect(r.ok && r.pulled).toBe(false);
    expect(run.calls).toEqual([["image", "inspect", "--format", "{{json .Config.Labels}}", REF]]);
    // Never started: no `run`, `create` or `start`.
    expect(run.calls.flat()).not.toContain("run");
  });

  it("pulls an image that isn't here, then reads its label", () => {
    const run = fakeDocker({ pullable: { [REF]: { [MANIFEST_LABEL]: FIXTURE_MANIFEST } } });
    const r = readImageManifest(REF, run);
    expect(r.ok && r.pulled).toBe(true);
    expect(run.calls.map((c) => c[0])).toEqual(["image", "pull", "image"]);
  });

  it("image not pullable: says so, with docker's reason", () => {
    const r = readImageManifest(REF, fakeDocker({}));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.lines.join("\n")).toMatch(/can't be pulled: .*pull access denied/);
  });

  it("label missing: says which label and how to add it", () => {
    for (const labels of [null, { "org.opencontainers.image.title": "x" }]) {
      const r = readImageManifest(REF, fakeDocker({ local: { [REF]: labels } }));
      expect(!r.ok && r.lines.join("\n")).toContain(`no ${MANIFEST_LABEL} label`);
    }
  });

  it("label invalid: not JSON, or the validator's messages", () => {
    const notJson = readImageManifest(REF, fakeDocker({ local: { [REF]: { [MANIFEST_LABEL]: "{nope" } } }));
    expect(!notJson.ok && notJson.lines.join("\n")).toContain("isn't JSON");

    const bad = { ...JSON.parse(FIXTURE_MANIFEST), id: "admin", version: "one" };
    const r = readImageManifest(REF, fakeDocker({ local: { [REF]: { [MANIFEST_LABEL]: JSON.stringify(bad) } } }));
    const text = !r.ok ? r.lines.join("\n") : "";
    expect(text).toMatch(/2 problem\(s\)/);
    expect(text).toContain("id");
    expect(text).toContain("is reserved by the platform");
    expect(text).toContain("version");
  });

  it("refuses anything that isn't an image reference, before calling docker", () => {
    const run = fakeDocker({});
    for (const ref of ["--privileged", "-v", "UPPER/case", "a b", "x:", "name@sha256:short"]) {
      expect(isImageRef(ref), ref).toBe(false);
      expect(readImageManifest(ref, run).ok).toBe(false);
    }
    expect(run.calls).toEqual([]);
    for (const ref of [
      "igs-web",
      "ext-demo:ci",
      "localhost:5000/team/app:1.2.3",
      `ghcr.io/a/b@sha256:${"a".repeat(64)}`,
    ]) {
      expect(isImageRef(ref), ref).toBe(true);
    }
  });
});
