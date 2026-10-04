import { describe, expect, it } from "vitest";
import { adminTokenMatches, appDatabasePort, decodeSubject } from "../src/server.ts";

const TOKEN = "t".repeat(40);

describe("admin token comparison (constant time, via digests)", () => {
  it("accepts the right bearer token only", () => {
    expect(adminTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("refuses a wrong token of the same length, a shorter and a longer one", () => {
    expect(adminTokenMatches(`Bearer ${"u".repeat(40)}`, TOKEN)).toBe(false);
    expect(adminTokenMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(adminTokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });

  it("refuses a missing header, a wrong scheme and an empty token", () => {
    expect(adminTokenMatches(undefined, TOKEN)).toBe(false);
    expect(adminTokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(adminTokenMatches("Basic " + TOKEN, TOKEN)).toBe(false);
    expect(adminTokenMatches("Bearer ", TOKEN)).toBe(false);
  });
});

describe("the app database port", () => {
  it("falls back to 5432 when the provisioner URL has no explicit port (URL.port is '')", () => {
    expect(new URL("postgres://u:p@db/postgres").port).toBe("");
    expect(appDatabasePort(undefined, new URL("postgres://u:p@db/postgres"))).toBe(5432);
  });

  it("uses the URL's port, and an explicit override first", () => {
    expect(appDatabasePort(undefined, new URL("postgres://u:p@db:55440/postgres"))).toBe(55440);
    expect(appDatabasePort("6000", new URL("postgres://u:p@db:55440/postgres"))).toBe(6000);
    expect(appDatabasePort("", new URL("postgres://u:p@db:55440/postgres"))).toBe(55440);
  });
});

describe("decodeSubject (subjects arrive percent-encoded)", () => {
  it("decodes the characters clients encode: ':' and '@'", () => {
    expect(decodeSubject("user%40example.test")).toBe("user@example.test");
    expect(decodeSubject("sub%3A123")).toBe("sub:123");
    expect(decodeSubject("dev-member")).toBe("dev-member");
  });

  it("refuses bad percent-encoding, a '/' hiding in an escape, spaces and over-long subjects", () => {
    for (const bad of ["%E0%A4%A", "a%2Fb", "a%20b", "%00", "x".repeat(129), ""]) {
      expect(() => decodeSubject(bad), bad).toThrow(/bad_request|subject/);
    }
  });
});
