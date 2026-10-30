import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SavedNotice } from "@/components/Notice";

describe("saved settings notice", () => {
  it.each([
    ["egress_hosts", "Webhook hosts saved."],
    ["email_recipients", "Email recipients saved."],
    ["paused", "Flow paused."],
    ["resumed", "Flow resumed."],
  ])("confirms %s with an accessible status", (saved, message) => {
    const html = renderToStaticMarkup(SavedNotice({ saved }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(message);
  });

  it("does not display a message for an unknown result", () => {
    expect(renderToStaticMarkup(SavedNotice({ saved: "unknown" }))).toBe("");
  });
});
