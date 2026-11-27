import { describe, expect, it } from "vitest";
import {
  accessByApp,
  accountAction,
  admissionFor,
  admissionText,
  personLabel,
  reactivateEffect,
  suspendEffect,
  type IdentityFacts,
} from "../lib/access";
import type { RoleMapping, SubjectGrant } from "../lib/core-api";

const apps = [
  { id: "knowledge", name: "Knowledge", state: "active" as const },
  { id: "docs", name: "Docs", state: "active" as const },
  { id: "flow", name: "Flow", state: "inactive" as const },
  { id: "old", name: "Old", state: "removed" as const },
];
const mappings: RoleMapping[] = [
  {
    id: 4,
    source: "core.admin",
    target: "knowledge.editor",
    createdBy: "ali",
    createdAt: "2026-11-01T00:00:00Z",
    derivedGrants: 1,
  },
];
const grant = (role: string, appId: string, by = "ali"): SubjectGrant => ({
  role,
  appId,
  granted_by: by,
  granted_at: "2026-11-02T00:00:00Z",
});
const person = (p: Partial<{ state: "active" | "suspended"; scope: "global" | "apps" | "none"; admitted: string[] }>) =>
  ({
    ok: true,
    person: { state: p.state ?? "active", scope: p.scope ?? "none", admittedClients: p.admitted ?? [] },
  }) satisfies IdentityFacts;

describe("access summary", () => {
  it("explains admission per app: global, per-app, not admitted; suspension beats everything", () => {
    expect(admissionFor(person({ scope: "global" }), "docs")).toEqual({ kind: "global" });
    expect(admissionFor(person({ scope: "apps", admitted: ["knowledge"] }), "knowledge")).toEqual({ kind: "admitted" });
    expect(admissionFor(person({ scope: "apps", admitted: ["knowledge"] }), "docs")).toEqual({ kind: "not-admitted" });
    expect(admissionFor(person({ state: "suspended", scope: "global", admitted: ["docs"] }), "docs")).toEqual({
      kind: "suspended",
    });
  });

  it("never treats a stored grant as access when identity can't be asked", () => {
    const rows = accessByApp(apps, { ok: false, reason: "unavailable" }, [grant("knowledge.author", "knowledge")], []);
    const k = rows.find((r) => r.appId === "knowledge")!;
    expect(k.admission).toEqual({ kind: "unknown", reason: "unavailable" });
    expect(k.attention).toBe("roles-without-admission");
    expect(admissionText(k.admission)).toBe("Unknown: identity isn't available");
  });

  it("gives each role its reason (direct, or the mapping's source role), lists apps with access first, drops removed", () => {
    const rows = accessByApp(
      apps,
      person({ scope: "apps", admitted: ["knowledge"] }),
      [
        grant("knowledge.author", "knowledge"),
        grant("knowledge.editor", "knowledge", "mapping:4"),
        grant("docs.reader", "docs"),
      ],
      mappings,
    );
    expect(rows.map((r) => r.appId)).toEqual(["knowledge", "docs", "flow"]);
    expect(rows[0]!.roles).toEqual([
      { role: "knowledge.author", reason: { kind: "direct", grantedBy: "ali", grantedAt: "2026-11-02T00:00:00Z" } },
      {
        role: "knowledge.editor",
        reason: { kind: "mapping", mappingId: 4, source: "core.admin", grantedAt: "2026-11-02T00:00:00Z" },
      },
    ]);
    expect(rows[0]!.attention).toBeNull();
    // A role in docs, but no admission there: flagged.
    expect(rows[1]).toMatchObject({ admission: { kind: "not-admitted" }, attention: "roles-without-admission" });
    expect(rows[2]).toMatchObject({ roles: [], attention: null });
  });

  it("a grant from a mapping that no longer exists still says so", () => {
    const [k] = accessByApp(
      apps,
      person({ scope: "global" }),
      [grant("knowledge.editor", "knowledge", "mapping:99")],
      [],
    );
    expect(k!.roles[0]!.reason).toMatchObject({ kind: "mapping", mappingId: 99, source: null });
  });

  it("labels a person by email, else a shortened account id", () => {
    expect(personLabel({ label: "a@example.test", id: "0190b6c4-0000-7000-8000-000000000001" })).toBe("a@example.test");
    expect(personLabel({ label: null, id: "0190b6c4-0000-7000-8000-000000000001" })).toBe("Account 0190b6c4…");
  });
});

describe("account actions on a profile", () => {
  const ID = "0190b6c4-0000-7000-8000-000000000009";
  const p = (
    over: Partial<{ state: "active" | "suspended"; scope: "global" | "apps" | "none"; isAdmin: boolean }>,
  ) => ({
    id: ID,
    label: "mo@example.test",
    admittedClients: ["knowledge"],
    state: over.state ?? "active",
    scope: over.scope ?? "global",
    isAdmin: over.isAdmin ?? false,
  });

  it("offers Suspend to someone with access, Reactivate to a suspended person, and nothing for yourself or no access", () => {
    expect(accountAction(p({}), "someone-else")).toBe("suspend");
    expect(accountAction(p({ state: "suspended", scope: "none" }), "someone-else")).toBe("reactivate");
    expect(accountAction(p({}), ID)).toBe("none-self");
    expect(accountAction(p({ scope: "none" }), "someone-else")).toBe("none-no-access");
  });

  it("says what suspending does, naming the person, the apps, and an administrator's extra loss", () => {
    expect(suspendEffect(p({}), [])).toBe(
      "mo@example.test can't sign in to any app from now on, and every session they have ends now. Their roles stay stored but give them nothing while they are suspended. You can reactivate them at any time.",
    );
    expect(suspendEffect(p({ scope: "apps" }), [])).toContain("can't sign in to knowledge from now on");
    const admin = suspendEffect(p({ isAdmin: true }), [{ role: "core.admin" }]);
    expect(admin).toContain("they lose identity administration too");
    expect(admin).toContain("They hold core.admin: they lose this console too");
  });

  it("says what reactivating does: every app again, or only the admissions of a public sign-up", () => {
    expect(reactivateEffect(p({}), "admin")).toContain("can sign in to every app");
    expect(reactivateEffect(p({}), "suspension")).toBe(
      "mo@example.test can sign in again to the apps they were admitted to (knowledge), and nothing more.",
    );
  });
});
