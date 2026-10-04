/**
 * The P3.2 acceptance flow, end to end in a real browser against the real
 * stack (identity, the dev login stub, core-api, Postgres):
 *
 *   install → the app self-registered → sign in as a seeded member →
 *   can read but can't write (403 naming the permission) →
 *   an admin grants notes.editor → writing works →
 *   deactivate → the app reports inactive.
 *
 * "The admin" is core-api's admin API (what `platform role grant` and
 * `platform app activate|deactivate` call), authorised with the dev token.
 */
import { expect, test, type Page } from "@playwright/test";

const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const SHOTS = "test-results/screens";

async function admin(method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${CORE_API}${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const grant = (role: string) => admin("PUT", `/admin/v1/roles/${role}/grants/dev-member`);
const revoke = (role: string) => admin("DELETE", `/admin/v1/roles/${role}/grants/dev-member`);

/** Sign in through identity and the dev login stub as one of the seeded users. */
async function signInAs(page: Page, displayName: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: new RegExp(displayName) }).click();
}

/** Reload until the access line shows `text` (the app's permission cache is 1 s in development). */
async function waitForAccess(page: Page, text: string) {
  await expect
    .poll(
      async () => {
        await page.goto("/");
        return (
          (await page
            .getByTestId("access")
            .textContent({ timeout: 1000 })
            .catch(() => "")) ?? ""
        );
      },
      { timeout: 20_000, intervals: [500, 1000] },
    )
    .toContain(text);
}

test.describe.configure({ mode: "serial" });

// Unique per run: the database keeps notes between runs.
const RUN = Date.now().toString(36);
const REFUSED = `refused ${RUN}`;
const FIRST = `First note ${RUN}`;
const SECOND = `Second note ${RUN}`;

test.beforeAll(async () => {
  expect(ADMIN_TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  // Re-runnable: no leftover grants, and not active (409 when it was only installed: fine).
  await revoke("notes.editor");
  await revoke("notes.viewer");
  await admin("POST", "/admin/v1/apps/notes/deactivate");
  // The app caches a person's access, INCLUDING the app's state, for ASAFARIM_ACCESS_TTL_MS (1 s in
  // development). A spec that ran before this one (gateway.spec.ts) leaves a fresh "active" answer for
  // dev-member; without this wait, the first page below can be served that stale answer and never
  // shows the "not active" notice. Let it expire.
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

test("the app registered itself with core-api on boot", async () => {
  const app = await admin("GET", "/admin/v1/apps/notes");
  expect(app.status).toBe(200);
  expect(app.body.registered_at).toBeTruthy(); // the signed self-registration happened
  const permissions = (app.body.permissions as { key: string }[]).map((p) => p.key);
  expect(permissions).toEqual(["notes.read", "notes.write"]);
  expect((app.body.roles as { key: string }[]).map((r) => r.key)).toEqual(["notes.editor", "notes.viewer"]);
});

test("nobody is signed in: the page offers sign-in and the API says 401", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const res = await request.get("/api/notes");
  expect(res.status()).toBe(401);
  expect(await res.json()).toMatchObject({ error: "unauthenticated" });
});

test("a seeded inactive account can't sign in", async ({ page }) => {
  await signInAs(page, "Dev Inactive");
  await expect(page.getByText("account_inactive")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/00-inactive-account-refused.png` });
});

test("member → read-only → editor → inactive", async ({ page }) => {
  await signInAs(page, "Dev Member");
  await expect(page.getByTestId("who")).toContainText("dev-member");

  // 1. The app isn't activated yet: it says so, and the API answers 503.
  await expect(page.getByTestId("state")).toContainText(/installed|inactive/);
  await page.screenshot({ path: `${SHOTS}/01-app-not-active.png` });
  const notActive = await page.request.get("/api/notes");
  expect(notActive.status()).toBe(503);
  expect(await notActive.json()).toMatchObject({ error: "app_inactive" });

  // 2. An admin activates it: signed in, but no roles yet, so no access.
  expect((await admin("POST", "/admin/v1/apps/notes/activate")).status).toBe(200);
  await waitForAccess(page, "permissions: none");
  await expect(page.getByTestId("no-read")).toContainText("notes.read");
  const noRole = await page.request.get("/api/notes");
  expect(noRole.status()).toBe(403);
  expect(await noRole.json()).toMatchObject({ error: "forbidden", permission: "notes.read" });

  // 3. An admin grants notes.viewer: the member can read but can't write.
  expect((await grant("notes.viewer")).body).toMatchObject({ granted: true });
  await waitForAccess(page, "notes.viewer");
  await expect(page.getByTestId("access")).not.toContainText("notes.write");
  expect((await page.request.get("/api/notes")).status()).toBe(200);

  const denied = await page.request.post("/api/notes", { data: { title: REFUSED } });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ error: "forbidden", permission: "notes.write" });

  await page.getByLabel("Title").fill(REFUSED);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("error")).toContainText("403 Forbidden");
  await expect(page.getByTestId("error")).toContainText("notes.write"); // the permission is named
  await page.screenshot({ path: `${SHOTS}/02-read-only-403-names-the-permission.png` });
  await expect(page.getByTestId("note").filter({ hasText: REFUSED })).toHaveCount(0);

  // 4. An admin grants notes.editor: writing works.
  expect((await grant("notes.editor")).body).toMatchObject({ granted: true });
  await waitForAccess(page, "notes.write");
  await page.getByLabel("Title").fill(FIRST);
  await page.getByLabel("Note").fill("Written by an editor.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("note").first()).toContainText(FIRST);
  await page.screenshot({ path: `${SHOTS}/03-editor-can-write.png` });

  const created = await page.request.post("/api/notes", { data: { title: SECOND, body: "via the API" } });
  expect(created.status()).toBe(201);
  const listed = (await (await page.request.get("/api/notes")).json()) as { notes: { title: string }[] };
  expect(listed.notes.map((n) => n.title)).toEqual(expect.arrayContaining([FIRST, SECOND]));

  // 5. An admin deactivates the app: it reports inactive, and the API refuses.
  expect((await admin("POST", "/admin/v1/apps/notes/deactivate")).body).toMatchObject({ state: "inactive" });
  await expect
    .poll(
      async () => {
        await page.goto("/");
        return (
          (await page
            .getByTestId("state")
            .textContent({ timeout: 1000 })
            .catch(() => "")) ?? ""
        );
      },
      { timeout: 20_000, intervals: [500, 1000] },
    )
    .toContain("inactive");
  await page.screenshot({ path: `${SHOTS}/04-app-inactive.png` });
  const off = await page.request.get("/api/notes");
  expect(off.status()).toBe(503);
  expect(await off.json()).toMatchObject({ error: "app_inactive", state: "inactive" });
});

test.afterAll(async () => {
  await revoke("notes.editor");
  await revoke("notes.viewer");
});
