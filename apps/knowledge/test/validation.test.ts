import { describe, expect, it } from "vitest";
import { isSlug, LIMITS, parseDraft, parseSlug, slugify } from "../lib/validation";

describe("validation", () => {
  it("makes URL slugs from titles", () => {
    expect(slugify("Understanding useEffect in React 19")).toBe("understanding-useeffect-in-react-19");
    expect(slugify("  Café & crème: ÉTÉ  ")).toBe("cafe-creme-ete");
    expect(slugify("C# / .NET")).toBe("c-net");
    expect(slugify("x".repeat(300)).length).toBe(LIMITS.slug);
    expect(slugify("!!!")).toBe("");
  });

  it("accepts only lower-case dashed slugs", () => {
    expect(isSlug("hello-world")).toBe(true);
    for (const bad of ["", "Hello", "a--b", "-a", "a-", "a/b", "../x", "a b"]) expect(isSlug(bad)).toBe(false);
    expect(parseSlug("", "Hello World")).toEqual({ ok: true, value: "hello-world" });
    expect(parseSlug("", "!!!")).toEqual({ ok: false, error: "invalid_slug" });
    expect(parseSlug("../etc", "x")).toEqual({ ok: false, error: "invalid_slug" });
  });

  it("requires a title and enforces the limits", () => {
    expect(parseDraft({ title: "  " })).toEqual({ ok: false, error: "title_required" });
    expect(parseDraft({ title: "x".repeat(201) })).toEqual({ ok: false, error: "title_too_long" });
    expect(parseDraft({ title: "t", summary: "s".repeat(501) })).toEqual({ ok: false, error: "summary_too_long" });
    expect(parseDraft({ title: "t", body: "b".repeat(200_001) })).toEqual({ ok: false, error: "body_too_long" });
    expect(parseDraft({ title: " T ", summary: 3, body: "a\r\nb" })).toEqual({
      ok: true,
      value: { title: "T", summary: "", body: "a\nb" },
    });
  });
});
