/** "Generate a draft" while the AI works (#288): disabled, "Generating…", a busy status with a progress bar. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GenerateSubmitView } from "../components/GenerateSubmit";

const render = (pending: boolean, disabled = false) =>
  renderToStaticMarkup(createElement(GenerateSubmitView, { pending, disabled }));

describe("the generate button", () => {
  it("idle: enabled, with the hint and no progress bar", () => {
    const html = render(false);
    expect(html).toContain(">Generate a draft</button>");
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain("This can take up to a minute.");
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('aria-busy="false"');
  });

  it("pending: disabled, Generating…, and a busy status with a labelled progress bar", () => {
    const html = render(true);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Generating…<\/button>/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Generating the draft"');
    // Indeterminate: no value, only a text.
    expect(html).not.toContain("aria-valuenow");
  });

  it("unavailable: disabled whatever the state", () => {
    expect(render(false, true)).toMatch(/<button[^>]*disabled/);
  });
});
