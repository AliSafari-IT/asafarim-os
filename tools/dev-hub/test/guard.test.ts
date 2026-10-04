import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevOnlyError, LISTEN_HOST, assertDevOnly } from "../src/guard.ts";
import { createDevHub } from "../src/server.ts";

const ok = { NODE_ENV: "development", DEV_HUB_IDENTITY_ISSUER: "http://localhost:4010" };

describe("dev login stub: development only (OS-D1, #26)", () => {
  it("allows NODE_ENV=development with a localhost issuer", () => {
    expect(assertDevOnly(ok)).toBe("http://localhost:4010");
    expect(assertDevOnly({ ...ok, DEV_HUB_IDENTITY_ISSUER: "http://127.0.0.1:4010" })).toBe("http://127.0.0.1:4010");
  });

  it("refuses any NODE_ENV other than development", () => {
    for (const NODE_ENV of ["production", "test", "", undefined]) {
      expect(() => assertDevOnly({ ...ok, NODE_ENV })).toThrow(DevOnlyError);
    }
  });

  it("refuses an issuer that isn't localhost, a missing one and a malformed one", () => {
    for (const issuer of [
      "https://id.asafarim.site",
      "http://localhost.evil.example",
      "http://10.0.0.5:4010",
      "",
      "not a url",
    ]) {
      expect(() => assertDevOnly({ ...ok, DEV_HUB_IDENTITY_ISSUER: issuer })).toThrow(DevOnlyError);
    }
  });

  it("createDevHub refuses to build a server outside development, before reading any key", async () => {
    await expect(
      createDevHub({ NODE_ENV: "production", DEV_HUB_IDENTITY_ISSUER: "http://localhost:4010" }),
    ).rejects.toThrow(DevOnlyError);
    await expect(
      createDevHub({ NODE_ENV: "development", DEV_HUB_IDENTITY_ISSUER: "https://id.asafarim.site" }),
    ).rejects.toThrow(DevOnlyError);
  });

  it("listens on 127.0.0.1 only", () => {
    expect(LISTEN_HOST).toBe("127.0.0.1");
  });

  it("never ships in the identity image: excluded from its build context, not a dependency", () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    expect(readFileSync(path.join(repo, "core/identity/Dockerfile.dockerignore"), "utf8")).toMatch(/^tools\/dev-hub$/m);
    const pkg = JSON.parse(readFileSync(path.join(repo, "core/identity/package.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("@asafarim/dev-hub");
    expect(readFileSync(path.join(repo, "core/identity/Dockerfile"), "utf8")).toContain(
      "--filter @asafarim/identity deploy --prod",
    );
  });
});
