import { describe, expect, it } from "vitest";
import { findPeople, fromIdentity, loadDirectory, parseDirectory, searchUsers } from "../lib/users";

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

describe("finding people for the role picker", () => {
  const person = {
    id: "0190b6c4-0000-7000-8000-000000000001",
    label: "ali@example.test",
    email: "ali@example.test",
    emailVerified: true,
    state: "suspended" as const,
    scope: "none" as const,
    admittedClients: [],
    isAdmin: false,
    createdAt: "2026-11-01T00:00:00Z",
    lastLoginAt: null,
  };

  it("asks identity's directory first, with the search text, and marks suspended people inactive", async () => {
    const asked: unknown[] = [];
    const identity = {
      users: async (f: unknown) => (asked.push(f), { users: [person], next: null }),
    } as unknown as NonNullable<NonNullable<Parameters<typeof findPeople>[3]>["identity"]>;
    const r = await findPeople("token", "  ali ", 5, { identity, seed: () => parseDirectory(SEED) });
    expect(asked).toEqual([{ q: "ali", limit: 5 }]);
    expect(r).toEqual({
      source: "identity",
      people: [{ id: person.id, name: "ali@example.test", email: "ali@example.test", isActive: false }],
    });
  });

  it("falls back to the seeded users when identity has no directory, and to nobody without them", async () => {
    const identity = {
      users: async () => {
        throw new Error("404");
      },
    } as unknown as NonNullable<NonNullable<Parameters<typeof findPeople>[3]>["identity"]>;
    const seeded = await findPeople("token", "member", 20, { identity, seed: () => parseDirectory(SEED) });
    expect(seeded.source).toBe("seed");
    expect(seeded.people.map((u) => u.id)).toEqual(["dev-member"]);
    expect(await findPeople("token", "", 20, { identity, seed: () => [] })).toEqual({ people: [], source: "none" });
  });

  it("labels a person without an email by a shortened account id", () => {
    expect(fromIdentity({ ...person, label: null, email: null, state: "active" })).toEqual({
      id: person.id,
      name: "Account 0190b6c4…",
      email: "",
      isActive: true,
    });
  });
});
