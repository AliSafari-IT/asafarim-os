// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocaleSelector } from "../src/react.tsx";

// vitest runs from the package folder (jsdom gives import.meta.url a different meaning).
const read = (name: string) => readFileSync(path.resolve(process.cwd(), name), "utf8");
const source = (name: string) => read(`src/${name}`);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<LocaleSelector /> (React apps)", () => {
  it("renders on the server as a closed, compact pill: no panel, no search, no list", () => {
    const html = renderToString(<LocaleSelector locale="nl" />);
    expect(html).toContain("cls-root");
    expect(html).toContain("locale-pill");
    expect(html).toContain('class="cls-trigger"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("BE");
    expect(html).toContain(">nl<");
    for (const open of ["cls-popover", "cls-search", "cls-list", "cls-option", "cls-backdrop", 'role="dialog"'])
      expect(html, open).not.toContain(open);
  });

  it("hydrates without a mismatch and stays closed; the trigger opens a floating dialog and Escape closes it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(<LocaleSelector locale="en" />);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <LocaleSelector locale="en" />);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();

    const trigger = container.querySelector<HTMLButtonElement>("button.cls-trigger")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.closest("body")!.querySelector(".cls-popover")).toBeNull();
    expect(container.querySelector(".cls-root")!.classList.contains("locale-pill")).toBe(true);

    await act(async () => {
      trigger.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"].cls-popover')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-label")).toBeTruthy();

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector(".cls-popover")).toBeNull();
  });

  it("loads its stylesheet with the component, so no app has to remember to", () => {
    expect(source("react.tsx")).toMatch(/^import "\.\.\/selector\.css";$/m);
  });
});

describe("selector.css", () => {
  const css = read("selector.css");

  it("carries the component's styles and the compact pill's, so loading one file is enough", () => {
    expect(css).toContain(".cls-popover");
    expect(css).toContain(".cls-root .cls-trigger");
    expect(css).toMatch(/\.cls-root \.cls-trigger \{[^}]*height: 2\.25rem;/);
    expect(css).toMatch(/\.cls-root \.cls-trigger \{[^}]*border-radius: 999px;/);
  });

  it("sizes every icon, floats the panel and hides it when closed", () => {
    expect(css).toMatch(/\.cls-root svg \{[^}]*width: 14px;[^}]*height: 14px;/);
    expect(css).toMatch(/\.cls-root \.cls-trigger__chev \{[^}]*width: 12px;[^}]*height: 12px;/);
    expect(css).toMatch(/\.cls-root \.cls-popover \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.cls-popover\[hidden\] \{\s*display: none;/);
  });

  it("takes its colours from the theme tokens and keeps a visible keyboard focus", () => {
    for (const token of ["--card", "--ink", "--muted", "--line", "--accent"]) expect(css).toContain(`var(${token}`);
    expect(css).toMatch(/\.cls-trigger:focus-visible \{[^}]*outline: 3px solid/);
    expect(css).toContain("prefers-reduced-motion");
  });
});
