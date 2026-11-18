import { describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { canCreate, canEdit, canPublish, canView, PERMISSIONS, seesAll, type Actor } from "../lib/policy";

/** The permissions a role carries, straight from the manifest, so the tests follow what admins grant. */
const roleGrants = (key: string) => manifest.roles.find((r) => r.key === key)!.grants;
const as = (subject: string, permissions: readonly string[]): Actor => ({ subject, permissions });

const alice = as("alice", roleGrants("knowledge.author"));
const editor = as("erin", roleGrants("knowledge.editor"));
const member = as("mallory", []);
const alicesItem = { ownerSubject: "alice" };
const bobsItem = { ownerSubject: "bob" };

describe("policy", () => {
  it("lets an author create, edit and publish only their own articles", () => {
    expect(canCreate(alice)).toBe(true);
    expect(canEdit(alice, alicesItem)).toBe(true);
    expect(canPublish(alice, alicesItem)).toBe(true);
    expect(canView(alice, bobsItem)).toBe(false);
    expect(canEdit(alice, bobsItem)).toBe(false);
    expect(canPublish(alice, bobsItem)).toBe(false);
    expect(seesAll(alice)).toBe(false);
  });

  it("lets an editor edit, publish and withdraw anyone's article", () => {
    expect(canEdit(editor, bobsItem)).toBe(true);
    expect(canPublish(editor, bobsItem)).toBe(true);
    expect(seesAll(editor)).toBe(true);
  });

  it("gives a signed-in person with no Knowledge role nothing, their own items included", () => {
    expect(canCreate(member)).toBe(false);
    expect(canView(as("mallory", []), { ownerSubject: "mallory" })).toBe(false);
    expect(canEdit(as("mallory", []), { ownerSubject: "mallory" })).toBe(false);
  });

  it("never infers privilege from a role name or a permission that only looks similar", () => {
    const lookalike = as("alice", ["core.admin", "knowledge.admin", "docs.owner", "knowledge.content.publish"]);
    expect(canCreate(lookalike)).toBe(false);
    expect(canPublish(lookalike, alicesItem)).toBe(false);
    expect(canEdit(lookalike, alicesItem)).toBe(false);
  });

  it("keeps editing and publishing separate: edit.own alone can't publish", () => {
    const writer = as("alice", [PERMISSIONS.create, PERMISSIONS.editOwn]);
    expect(canEdit(writer, alicesItem)).toBe(true);
    expect(canPublish(writer, alicesItem)).toBe(false);
  });
});
