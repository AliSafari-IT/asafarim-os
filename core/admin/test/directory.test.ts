import { describe, expect, it } from "vitest";
import { directoryHref, parseView, safeBack } from "../lib/directory";

describe("the Users directory's URLs", () => {
  it("keeps only well-formed filters and the cursor; never a search text", () => {
    expect(parseView({ state: "active", scope: "apps", after: "abc_DEF-1", q: "ali@example.test" })).toEqual({
      state: "active",
      scope: "apps",
      after: "abc_DEF-1",
    });
    expect(parseView({ state: "deleted", scope: "<script>", after: "a b" })).toEqual({});
    expect(directoryHref({ state: "suspended", after: "c1" })).toBe("/admin/users?state=suspended&after=c1");
    expect(directoryHref({})).toBe("/admin/users");
  });

  it("goes back only to the directory itself, rebuilt from its safe parts", () => {
    expect(safeBack("/admin/users?state=active&after=c2")).toBe("/admin/users?state=active&after=c2");
    expect(safeBack("/admin/users?q=ali%40example.test&scope=none")).toBe("/admin/users?scope=none");
    for (const bad of [
      undefined,
      "",
      "https://evil.example/admin/users",
      "//evil.example",
      "/admin/roles",
      "/admin/usersx",
    ]) {
      expect(safeBack(bad), String(bad)).toBe("/admin/users");
    }
  });
});
