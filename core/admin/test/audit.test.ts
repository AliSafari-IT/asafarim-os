/** How the Audit pages read the two trails (lib/audit.ts, lib/audit-filters.ts). */
import { describe, expect, it } from "vitest";
import {
  actorName,
  attention,
  csvCell,
  dayAfter,
  dayParam,
  describeChange,
  describeSignIn,
  isSensitiveChange,
  signInKindOf,
  signInSeries,
  toCsv,
  withChanges,
} from "@/lib/audit";
import { changeFilters, changeQuery, signInFilters, signInQuery } from "@/lib/audit-filters";

const change = (action: string, detail: Record<string, unknown> = {}, appId: string | null = "notes") => ({
  action,
  detail,
  appId,
  actor: "user:dev-admin",
});
const signIn = (event: string, over: Record<string, unknown> = {}) => ({
  event,
  method: null,
  detail: {},
  actorLabel: null,
  actorId: null,
  ...over,
});

describe("admin changes", () => {
  it("names actors plainly", () => {
    expect(actorName("user:dev-admin")).toBe("dev-admin");
    expect(actorName("admin")).toBe("the command line (admin token)");
    expect(actorName("app:notes")).toBe("the app notes");
  });

  it("one sentence per action, with a tone", () => {
    expect(describeChange(change("role.granted", { role: "notes.editor", subject: "dev-member" }))).toEqual({
      kind: "roles",
      label: "Granted",
      tone: "good",
      sentence: "Granted notes.editor to dev-member.",
    });
    expect(describeChange(change("role.granted", { role: "core.admin", subject: "x" }, "core")).tone).toBe("warn");
    expect(describeChange(change("app.removed")).tone).toBe("bad");
    expect(describeChange(change("event_schemas.updated", { types: ["a", "b"] })).sentence).toBe(
      "notes uploaded 2 event schemas.",
    );
    expect(describeChange(change("something.new")).sentence).toBe("something.new on notes.");
  });

  it("flags platform-admin grants, removals and purges as sensitive, nothing else", () => {
    expect(isSensitiveChange(change("role.granted", { role: "core.admin" }))).toBe(true);
    expect(isSensitiveChange(change("role.revoked", { role: "core.admin" }))).toBe(true);
    expect(isSensitiveChange(change("app.purged"))).toBe(true);
    expect(isSensitiveChange(change("role.granted", { role: "notes.editor" }))).toBe(false);
    expect(isSensitiveChange(change("app.activated"))).toBe(false);
  });
});

describe("sign-ins & access", () => {
  it("groups events, including kinds and events this console doesn't know", () => {
    expect(signInKindOf("login.granted")).toBe("signins");
    expect(signInKindOf("google.failed")).toBe("failures");
    expect(signInKindOf("request.updated")).toBe("access");
    expect(signInKindOf("connection.revoked")).toBe("connections");
    expect(signInKindOf("passkey.failed")).toBe("failures");
    expect(signInKindOf("brand.new")).toBe("other");
  });

  it("one sentence per event, naming who decided", () => {
    expect(describeSignIn(signIn("login.granted", { method: "google" })).sentence).toBe("Signed in with google.");
    expect(describeSignIn(signIn("login.granted", { detail: { via: "session", clientId: "notes" } })).sentence).toBe(
      "Signed in to notes with their open session.",
    );
    expect(describeSignIn(signIn("request.created", { detail: { apps: "notes,docs" } })).sentence).toBe(
      "Asked for access to notes, docs: waiting for an admin.",
    );
    expect(describeSignIn(signIn("request.approved", { actorLabel: "ali@example.test" })).sentence).toBe(
      "Access approved by ali@example.test.",
    );
    expect(describeSignIn(signIn("google.failed", { detail: { reason: "state_mismatch" } })).sentence).toBe(
      "Google sign-in didn't complete (state mismatch).",
    );
    expect(describeSignIn(signIn("admin.denied", { detail: { via: "audit_api" } })).tone).toBe("bad");
    expect(describeSignIn(signIn("connection.added", { detail: { reconnect: true } })).label).toBe("Reconnected");
  });
});

describe("overview", () => {
  const days = (failures: number[]) =>
    failures.map((f, i) => ({ day: `2026-10-${String(10 + i)}`, signins: 1, failures: f, access: 0, changes: 0 }));

  it("folds identity's events into the chart's series and adds core-api's changes by day", () => {
    const s = signInSeries([
      {
        day: "2026-10-25",
        events: { "login.granted": 2, "otp.verify_failed": 1, "admin.denied": 1, "request.created": 1, "otp.sent": 5 },
      },
    ]);
    expect(s).toEqual([{ day: "2026-10-25", signins: 2, failures: 2, access: 1, changes: 0 }]);
    expect(
      withChanges(s, [
        { day: "2026-10-25", total: 3 },
        { day: "2026-10-26", total: 1 },
      ]),
    ).toEqual([
      { day: "2026-10-25", signins: 2, failures: 2, access: 1, changes: 3 },
      { day: "2026-10-26", signins: 0, failures: 0, access: 0, changes: 1 },
    ]);
  });

  it("raises waiting requests, a failure spike, refused admin access and sensitive changes", () => {
    const items = attention({
      pendingRequests: 2,
      days: days([1, 2, 1, 30]),
      deniedAdmin: 1,
      sensitiveChanges: [change("role.granted", { role: "core.admin", subject: "sam" }, "core")],
      identityAdminUrl: "https://id.example.test/admin",
    });
    expect(items.map((i) => i.tone)).toEqual(["warn", "bad", "warn", "warn"]);
    expect(items[0]).toMatchObject({ href: "https://id.example.test/admin", link: "Review requests" });
    expect(items[0]!.text).toContain("2 people are waiting");
    expect(items[1]!.text).toContain("30 failed sign-ins today");
    expect(items[3]!.text).toBe("Granted core.admin to sam: full platform administrator. By dev-admin.");
  });

  it("stays quiet on an ordinary day: a few failures are not a spike", () => {
    expect(attention({ days: days([5, 6, 4, 9]) })).toEqual([]);
    expect(attention({ days: days([0, 0, 0, 8]) })).toEqual([]); // not more than 10
  });
});

describe("CSV", () => {
  it("quotes what must be quoted and neutralises formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell(null)).toBe("");
    expect(csvCell({ role: "x" })).toBe('"{""role"":""x""}"');
    expect(toCsv(["a", "b"], [[1, "x\ny"]])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});

describe("filters", () => {
  it("dates: a valid day, and the day after for an inclusive 'to'", () => {
    expect(dayParam("2026-10-26")).toBe("2026-10-26");
    expect(dayParam("26/10/2026")).toBeUndefined();
    expect(dayParam("2026-02-31x")).toBeUndefined();
    expect(dayAfter("2026-10-31")).toBe("2026-11-01");
  });

  it("admin changes: keeps valid filters, drops the rest, and round-trips through the query", () => {
    const f = changeFilters({
      app: "notes",
      action: "role.",
      actor: "  dev-admin ",
      involving: "dev-member",
      from: "2026-10-01",
      to: "nope",
      before: "42",
    });
    expect(f).toEqual({
      app: "notes",
      action: "role.",
      actor: "dev-admin",
      involving: "dev-member",
      from: "2026-10-01",
      to: undefined,
      before: 42,
    });
    expect(changeQuery(f)).toBe("app=notes&actor=dev-admin&action=role.&involving=dev-member&from=2026-10-01");
    expect(changeFilters({ app: "Bad App", action: "drop table", involving: "a b" })).toMatchObject({
      app: undefined,
      action: undefined,
      involving: undefined,
    });
    expect(changeFilters({ app: "core" }).app).toBe("core");
  });

  it("sign-ins: a known kind and method, a uuid person, a fingerprint", () => {
    const id = "0190B6C4-0000-7000-8000-000000000001";
    const f = signInFilters({ kind: "failures", method: "google", principal: id, handle: "abcdefgh1234" });
    expect(f).toMatchObject({
      kind: "failures",
      method: "google",
      principal: id.toLowerCase(),
      handle: "abcdefgh1234",
    });
    expect(signInQuery(f, { before: "9" })).toBe(
      `kind=failures&method=google&principal=${id.toLowerCase()}&handle=abcdefgh1234&before=9`,
    );
    expect(signInFilters({ kind: "everything", method: "fax", principal: "1", handle: "x" })).toMatchObject({
      kind: undefined,
      method: undefined,
      principal: undefined,
      handle: undefined,
    });
  });
});
