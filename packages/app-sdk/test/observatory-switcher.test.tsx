/// <reference lib="dom" />
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AppSwitcher } from "../src/app-switcher.tsx";

it("opens Observatory from the switcher even when the person has no protected OS app grants", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<AppSwitcher apps={[]} current="docs" fallback={{ name: "Docs", glyph: "DC" }} />),
    );
    const button = host.querySelector("button")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const link = host.querySelector('a[href="https://observatory.asafarim.site/"]');
    expect(link?.textContent).toContain("Observatory");
    expect(host.querySelectorAll("a.asafarim-switcher__tile")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
