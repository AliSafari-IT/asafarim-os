import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedLink, parseProgress } from "../src/progress.ts";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "progress.json");
const real = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("the checked-in progress file", () => {
  it("is valid", () => {
    const progress = parseProgress(real());
    expect(progress.shipped.length).toBeGreaterThan(0);
    expect(progress.screenshots.length).toBeGreaterThan(0);
    expect(progress.roadmap.map((r) => r.id)).toEqual(["P4", "P6", "P7"]);
  });

  it("says nothing about migrating asafarim.com apps (ADR 0001 Amendment B)", () => {
    expect(readFileSync(file, "utf8")).not.toMatch(/migrat/i);
  });
});

describe("parseProgress", () => {
  // The tests break the parsed JSON on purpose, so its shape is loose here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withChange = (change: (p: Record<string, any>) => void) => {
    const p = real();
    change(p);
    return () => parseProgress(p);
  };

  it("refuses a date that is not a real YYYY-MM-DD day", () => {
    expect(withChange((p) => (p.shipped[0].date = "2026-02-30"))).toThrow(/shipped\[0\]\.date/);
    expect(withChange((p) => (p.updated = "10/10/2026"))).toThrow(/updated/);
  });

  it("refuses a milestone without merged pull requests", () => {
    expect(withChange((p) => (p.shipped[0].prs = []))).toThrow(/prs/);
    expect(withChange((p) => (p.shipped[0].prs = [0]))).toThrow(/prs/);
  });

  it("refuses links to other hosts, plain http and javascript: URLs", () => {
    expect(withChange((p) => (p.links[0].href = "https://example.com/"))).toThrow(/links\[0\]\.href/);
    expect(withChange((p) => (p.links[0].href = "http://github.com/"))).toThrow(/links\[0\]\.href/);
    expect(withChange((p) => (p.links[0].href = "javascript:alert(1)"))).toThrow(/links\[0\]\.href/);
    expect(withChange((p) => (p.repo = "https://github.com/a/b/c"))).toThrow(/repo/);
  });

  it("refuses a screenshot path that leaves the screenshots folder", () => {
    expect(withChange((p) => (p.screenshots[0].file = "../secret.png"))).toThrow(/screenshots\[0\]\.file/);
    expect(withChange((p) => (p.screenshots[0].file = "shot.jpg"))).toThrow(/screenshots\[0\]\.file/);
  });

  it("refuses a screenshot without alt text, and duplicate ids", () => {
    expect(withChange((p) => (p.screenshots[0].alt = " "))).toThrow(/alt/);
    expect(withChange((p) => (p.shipped[1].id = p.shipped[0].id))).toThrow(/twice/);
  });
});

describe("isAllowedLink", () => {
  it("allows https links to github.com and asafarim.com only", () => {
    expect(isAllowedLink("https://github.com/AliSafari-IT/asafarim-os/pull/1")).toBe(true);
    expect(isAllowedLink("https://asafarim.com/")).toBe(true);
    expect(isAllowedLink("https://evil.github.com.example/")).toBe(false);
    expect(isAllowedLink("https://user@github.com/")).toBe(false);
    expect(isAllowedLink("https://github.com:8443/")).toBe(false);
    expect(isAllowedLink("not a url")).toBe(false);
  });
});
