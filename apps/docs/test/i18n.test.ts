import { describe, expect, it } from "vitest";
import { MESSAGES, messagesFor } from "../lib/i18n";

describe("Docs in four languages", () => {
  it("every language has every message, none empty", () => {
    const en = MESSAGES.en;
    for (const locale of ["nl", "fr", "de"] as const) {
      expect(Object.keys(MESSAGES[locale]).sort(), locale).toEqual(Object.keys(en).sort());
    }
    for (const [locale, m] of Object.entries(MESSAGES)) {
      for (const [key, value] of Object.entries(m)) {
        const text = typeof value === "function" ? (value as (...a: never[]) => string)(...([2, 2] as never[])) : value;
        expect(String(text).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("English stays the words the end-to-end tests read", () => {
    const m = messagesFor("en");
    expect(m.signIn).toBe("Sign in");
    expect(m.addNote).toBe("Add note");
    expect(m.minRead(3)).toBe("3 min read");
    expect(m.diagramTitled("Demo")).toBe("Diagram: Demo");
  });
});
