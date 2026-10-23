import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonDetail, ShortId, When } from "../components/Cells";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("table cells", () => {
  it("a time is one line to the minute, with the seconds in the tooltip", () => {
    expect(html(createElement(When, { iso: "2026-10-23T13:54:55.123Z" }))).toBe(
      '<time class="os-nowrap" dateTime="2026-10-23T13:54:55.123Z" title="2026-10-23 13:54:55 UTC">2026-10-23 13:54 UTC</time>',
    );
  });

  it("a long id keeps its whole text (selectable, testable), is clipped by CSS and can be copied", () => {
    const id = "user:ca8c0ba7-420b-4fee-8b5f-df5161102bad";
    const out = html(createElement(ShortId, { value: id, testId: "actor" }));
    expect(out).toContain(`<span class="os-id" title="${id}" data-testid="actor">${id}</span>`);
    expect(out).toContain(`aria-label="Copy ${id}"`);
    // A short one needs no copy button.
    expect(html(createElement(ShortId, { value: "admin" }))).not.toContain("Copy");
  });

  it("JSON detail is one line that opens to the pretty-printed whole; empty values stay plain", () => {
    const out = html(createElement(JsonDetail, { value: { role: "core.admin", n: 1 } }));
    expect(out).toContain('<details class="os-json">');
    expect(out).toContain("<summary");
    expect(out).toContain("{&quot;role&quot;:&quot;core.admin&quot;,&quot;n&quot;:1}</summary>");
    expect(out).toContain("<pre>{\n  &quot;role&quot;: &quot;core.admin&quot;,\n  &quot;n&quot;: 1\n}</pre>");
    expect(html(createElement(JsonDetail, { value: {} }))).not.toContain("<details");
    expect(html(createElement(JsonDetail, { value: null }))).toContain("—");
  });
});
