import { describe, expect, it } from "vitest";
import { accessByApp, admissionFor, admissionText, personLabel, type IdentityFacts } from "../lib/access";
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
