import { describe, expect, it } from "vitest";
import { loadDirectory, parseDirectory, searchUsers } from "../lib/users";

const SEED = JSON.stringify({
  _comment: "x",
  users: [
    { id: "dev-owner", email: "owner@dev.test", name: "Dev Owner", isActive: true, roles: ["owner"] },
    { id: "dev-member", email: "member@dev.test", name: "Dev Member", isActive: true },
    { id: "dev-inactive", email: "inactive@dev.test", name: "Dev Inactive", isActive: false },
    { name: "no id" },
  ],
});

describe("the seeded user directory", () => {
  it("reads id, name, email and whether they can sign in, skipping entries with no id and never exposing roles", () => {
    const users = parseDirectory(SEED);
    expect(users.map((u) => u.id)).toEqual(["dev-owner", "dev-member", "dev-inactive"]);
    expect(users[2]).toEqual({ id: "dev-inactive", name: "Dev Inactive", email: "inactive@dev.test", isActive: false });
    expect(Object.keys(users[0]!).sort()).toEqual(["email", "id", "isActive", "name"]);
  });

  it("searches id, name and email, case-insensitively; no query lists everyone; capped", () => {
    const users = parseDirectory(SEED);
    expect(searchUsers(users, "").map((u) => u.id)).toHaveLength(3);
    expect(searchUsers(users, "MEMBER").map((u) => u.id)).toEqual(["dev-member"]);
    expect(searchUsers(users, "owner@dev").map((u) => u.id)).toEqual(["dev-owner"]);
    expect(searchUsers(users, "  dev  ", 2)).toHaveLength(2);
    expect(searchUsers(users, "zzz")).toEqual([]);
  });

  it("an unset, missing or broken directory is empty, never an error (type the subject id instead)", () => {
    expect(loadDirectory(undefined)).toEqual([]);
    expect(loadDirectory("/definitely/not/here.json")).toEqual([]);
    expect(() => parseDirectory("{nope")).toThrow();
    expect(parseDirectory("{}")).toEqual([]);
  });
});
