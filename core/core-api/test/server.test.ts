import { describe, expect, it } from "vitest";
import { adminTokenMatches, appDatabasePort } from "../src/server.ts";

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
