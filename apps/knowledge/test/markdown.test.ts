import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";

async function render(markdown: string): Promise<string> {
  // Markdown is an async server component; MarkdownAsync inside it is too. Resolve both, then render.
  const outer = await Markdown({ markdown });
  const inner = outer.props.children as { type: (p: unknown) => Promise<ReactElement>; props: unknown };
  const rendered = await inner.type(inner.props);
  return renderToStaticMarkup(createElement("div", null, rendered));
}

describe("article rendering", () => {
  it("renders GitHub-flavoured Markdown", async () => {
    const html = await render("# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`useEffect`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>useEffect</code>");
  });

  it("never renders raw HTML, scripts, handlers or javascript: links", async () => {
    const html = await render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n<iframe src="https://evil.example"></iframe>',
    );
    expect(html).not.toMatch(/<script|onerror|<iframe|javascript:/i);
    expect(html).toContain("click");
  });
});
