/**
 * What the Docs browser suites share (#80, #81): the stack's addresses, signing in through identity
 * and the dev login stub, core-api's admin API, and Lighthouse's accessibility score.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import lighthouse from "lighthouse";

export const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
export const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
export const BASE = process.env.E2E_DOCS_URL ?? "http://localhost:4110";
export const SHOTS = "test-results/screens";
export const ROADMAP = "ventures/demo-app/roadmap/roadmap.md";
export const roadmapUrl = (hash = "") => `/?doc=${encodeURIComponent(ROADMAP)}${hash}`;
export const MIN_A11Y = 0.95;

export async function admin(method: string, p: string) {
  const res = await fetch(`${CORE_API}${p}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  return res.status;
}

/** Docs active and docs.owner granted to dev-member (the app caches a person's access for 1 s). */
export async function grantOwner() {
  expect(ADMIN_TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  // 409 when it's already active: fine.
  expect([200, 409]).toContain(await admin("POST", "/admin/v1/apps/docs/activate"));
  expect(await admin("PUT", "/admin/v1/roles/docs.owner/grants/dev-member")).toBeLessThan(300);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

export async function revokeOwner() {
  await admin("DELETE", "/admin/v1/roles/docs.owner/grants/dev-member");
  await admin("POST", "/admin/v1/apps/docs/deactivate");
}

/** Sign in through identity and the dev login stub as dev-member. */
export async function signIn(page: Page) {
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Dev Member/ }).click();
  await expect(page.getByTestId("who")).toBeVisible();
}

/**
 * Lighthouse (accessibility only) on a page, signed in: Chromium is launched with a DevTools port,
 * signed in through Playwright, and Lighthouse opens the page in that same browser.
 */
export async function accessibilityScore(scheme: "light" | "dark", url = roadmapUrl()) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "docs-lh-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Full Chromium (new headless), the browser Lighthouse is made for.
    channel: "chromium",
    args: ["--remote-debugging-port=0", ...(scheme === "dark" ? ["--force-dark-mode"] : [])],
    viewport: { width: 1350, height: 940 },
    // No emulated colour scheme: Lighthouse's tab has to see the browser's own.
    colorScheme: null,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await signIn(page);
    await page.goto(`${BASE}${url}`);
    // The scheme Lighthouse will see is the browser's own, not an emulation of this page.
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(scheme === "dark");
    const port = Number(readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    const result = await lighthouse(
      `${BASE}${url}`,
      { port, onlyCategories: ["accessibility"], disableStorageReset: true, logLevel: "error", output: "json" },
      {
        extends: "lighthouse:default",
        settings: { formFactor: "desktop", screenEmulation: { disabled: true }, throttlingMethod: "provided" },
      },
    );
    const lhr = result!.lhr;
    const failing = Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary")
      .map((a) => {
        // Which elements, so a failure says where to look.
        const items = ((a.details as { items?: { node?: { snippet?: string; explanation?: string } }[] } | undefined)
          ?.items ?? []) as { node?: { snippet?: string; explanation?: string } }[];
        const nodes = items.map((i) => `${i.node?.snippet ?? "?"} (${i.node?.explanation?.split("\n")[0] ?? ""})`);
        return [`${a.id}: ${a.title}`, ...nodes.slice(0, 5)].join("\n    ");
      });
    return { url, scheme, score: lhr.categories.accessibility!.score ?? 0, failing };
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
