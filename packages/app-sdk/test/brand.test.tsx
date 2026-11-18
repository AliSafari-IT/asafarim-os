import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppBrand } from "../src/react.tsx";

describe("AppBrand", () => {
  it("is the app's glyph and name, one link to its home", () => {
    const html = renderToStaticMarkup(<AppBrand name="Flow" glyph="FL" />);
    expect(html).toMatch(/^<div class="asafarim-brand"/);
    expect(html).toContain('<a class="asafarim-brand__link" href="/">');
    expect(html).toContain('aria-hidden="true">FL</span><span>Flow</span>');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("can be the page's heading, and link elsewhere", () => {
    const html = renderToStaticMarkup(<AppBrand name="Notes" glyph="NT" href="/notes" as="h1" />);
    expect(html).toMatch(/^<h1 class="asafarim-brand"/);
    expect(html).toContain('href="/notes"');
  });

  it("shows the app's own symbol in place of the glyph text when given one", () => {
    const html = renderToStaticMarkup(<AppBrand name="Knowledge" glyph="KN" icon={<svg data-testid="mark" />} />);
    expect(html).toContain(
      '<span class="asafarim-brand__icon" aria-hidden="true"><svg data-testid="mark"></svg></span><span>Knowledge</span>',
    );
    expect(html).not.toContain(">KN<");
  });
});
