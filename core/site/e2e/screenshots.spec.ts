/**
 * Generates the site's screenshots (public/screenshots/*.png) from the e2e environment, never by hand.
 * Run through `pnpm screenshots` at the repository root, which starts the stack and sets the E2E_* URLs.
 *
 * Setup through core-api's admin API (the CLI's token): Dev Admin holds core.admin, Notes is active,
 * and Dev Member can write notes. Each shot is the 1280×800 viewport, light theme.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN = process.env.E2E_ADMIN_URL ?? "http://core.localhost:8080";
const NOTES = process.env.E2E_GATEWAY_URL ?? "http://notes.localhost:8080";
const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "screenshots");

async function cli(method: string, urlPath: string) {
  const res = await fetch(`${CORE_API}${urlPath}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status, `${method} ${urlPath}`).toBeLessThan(500);
}

async function signIn(page: Page, url: string, displayName: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in" }).click();
  const chooser = page.getByRole("button", { name: new RegExp(displayName) });
  const signedIn = page.getByTestId("who");
  await expect(chooser.or(signedIn)).toBeVisible({ timeout: 20_000 });
  if (await chooser.isVisible()) await chooser.click();
  await expect(signedIn).toBeVisible();
}

const shot = (page: Page, file: string) => page.screenshot({ path: path.join(OUT, file), animations: "disabled" });

async function newPage(browser: Browser) {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(TOKEN, "E2E_ADMIN_TOKEN must be set (run `pnpm screenshots` at the repository root)").not.toBe("");
  await cli("PUT", "/admin/v1/roles/core.admin/grants/dev-admin");
  await cli("POST", "/admin/v1/apps/notes/activate");
  await cli("PUT", "/admin/v1/roles/notes.editor/grants/dev-member");
});

test("Admin: Apps, an app's roles and grants, Events", async ({ browser }) => {
  const page = await newPage(browser);
  await signIn(page, `${ADMIN}/admin`, "Dev Admin");

  await page.goto(`${ADMIN}/admin/apps`);
  await expect(page.getByRole("heading", { level: 2, name: "Apps" })).toBeVisible();
  await expect(page.getByTestId("state-notes")).toHaveText("active");
  await shot(page, "admin-apps.png");

  await page.goto(`${ADMIN}/admin/roles?app=notes`);
  await expect(page.getByRole("heading", { level: 2, name: "Roles & grants" })).toBeVisible();
  await expect(page.getByTestId("holder-notes.editor-dev-member")).toBeVisible();
  await shot(page, "admin-app-roles.png");

  // Notes uploads its event schema when it registers: wait for it rather than racing it.
  await expect
    .poll(
      async () => (
        await page.goto(`${ADMIN}/admin/events`),
        await page
          .getByTestId("schema-status-notes.note.created.v1")
          .textContent()
          .catch(() => "")
      ),
      { timeout: 30_000 },
    )
    .toBe("Schema provided");
  await shot(page, "admin-events.png");
});

test("Notes, signed in through the OS", async ({ browser }) => {
  const page = await newPage(browser);
  await signIn(page, NOTES, "Dev Member");
  // The permission lookup is cached for a second in development.
  await expect
    .poll(
      async () => (
        await page.reload(),
        await page
          .getByTestId("access")
          .textContent()
          .catch(() => "")
      ),
      { timeout: 20_000 },
    )
    .toContain("notes.write");
  if ((await page.getByTestId("note").count()) === 0) {
    for (const title of ["Plan the OS landing page", "Every app gets sign-in from the OS"]) {
      await page.getByLabel("Title").fill(title);
      await page.getByRole("button", { name: "Add note" }).click();
      await expect(page.getByTestId("note").first()).toContainText(title);
    }
  }
  await shot(page, "notes.png");
});
