import { describe, expect, it } from "vitest";
import { MESSAGES, messagesFor } from "../lib/i18n";

describe("Admin console chrome in four languages", () => {
  it("every language has every message, none empty", () => {
    const shape = (v: unknown, path = ""): string[] =>
      v && typeof v === "object"
        ? Object.entries(v).flatMap(([k, x]) => shape(x, `${path}.${k}`))
        : [`${path}:${typeof v === "string" && v.length > 0 ? "ok" : "EMPTY"}`];
    const english = shape(MESSAGES.en);
    expect(english.filter((s) => s.endsWith("EMPTY"))).toEqual([]);
    for (const locale of ["nl", "fr", "de"] as const) expect(shape(MESSAGES[locale]), locale).toEqual(english);
  });

  it("English stays the words the end-to-end tests read", () => {
    const m = messagesFor("en");
    expect(m.nav.roles).toBe("Roles & grants");
    expect(m.signIn).toBe("Sign in");
    expect(m.forbiddenTitle).toBe("403: not allowed");
  });
});
