/**
 * The P3.3a acceptance flow, through the GATEWAY (http://notes.localhost:8080):
 *
 *   inactive → the "temporarily unavailable" page (never proxied) →
 *   active, signed out → sign-in →
 *   a member without the role → 403 AT the gateway for a permission-marked route →
 *   an editor → allowed → expose:false → 404 (though the app serves it) →
 *   a revoked grant takes effect within the token's lifetime →
 *   deactivate → unavailable at once.
 *
 * "At the gateway" is told apart from "in the app" by the body: the gateway's
 * 403 is exactly {error, permission}; the app's also carries a `message`.
 *
 * `pnpm e2e` runs core-api with a short token lifetime (E2E_TOKEN_TTL) so the
 * revocation bound is exercised for real, not mocked.
 */
import { expect, test, type Page } from "@playwright/test";

const GATEWAY = process.env.E2E_GATEWAY_URL ?? "http://notes.localhost:8080";
const DIRECT = process.env.E2E_BASE_URL ?? "http://localhost:4100";
const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const TOKEN_TTL = Number(process.env.E2E_TOKEN_TTL ?? 60);
const SHOTS = "test-results/screens";

async function admin(method: string, path: string) {
  const res = await fetch(`${CORE_API}${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const grant = (role: string) => admin("PUT", `/admin/v1/roles/${role}/grants/dev-member`);
const revoke = (role: string) => admin("DELETE", `/admin/v1/roles/${role}/grants/dev-member`);

/**
 * A request made BY THE BROWSER from the page (so cookies, Host and `*.localhost`
 * resolution are the browser's own; Node's resolver doesn't know `*.localhost`
 * everywhere). Redirects are followed.
 */
async function browserFetch(page: Page, method: "GET" | "POST", path: string, data?: object) {
  return page.evaluate(
    async ({ url, method, data }) => {
      const res = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: data ? { "content-type": "application/json" } : {},
        body: data ? JSON.stringify(data) : undefined,
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text);
      } catch {
        /* an HTML page */
      }
      return { status: res.status, body, text };
    },
    { url: `${GATEWAY}${path}`, method, data },
  );
}

/**
 * An API call the way a client uses the documented contract: when the gateway
 * answers 401 {refresh}, call that path (it re-issues the token cookie for a
 * signed-in person) and try once more.
 */
async function api(page: Page, method: "GET" | "POST", path: string, data?: object) {
  let res = await browserFetch(page, method, path, data);
  if (res.status === 401 && typeof res.body.refresh === "string") {
    await browserFetch(page, "GET", `${res.body.refresh}?next=/`);
    res = await browserFetch(page, method, path, data);
  }
  return res;
}

/** Poll `api` until it answers `status`, within `withinMs`; returns how long it took. */
async function untilStatus(
  page: Page,
  status: number,
  method: "GET" | "POST",
  path: string,
  data?: object,
  withinMs = 20_000,
) {
  const started = Date.now();
  await expect
    .poll(async () => (await api(page, method, path, data)).status, { timeout: withinMs, intervals: [500, 1000] })
    .toBe(status);
  return Date.now() - started;
}

async function signInThroughGateway(page: Page, displayName: string) {
  await page.goto(`${GATEWAY}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: new RegExp(displayName) }).click();
  await expect(page.getByTestId("who")).toContainText("dev-member");
}

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);

test.beforeAll(async () => {
  expect(ADMIN_TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  await revoke("notes.editor");
  await revoke("notes.viewer");
  await admin("POST", "/admin/v1/apps/notes/deactivate");
});

test.afterAll(async () => {
  await revoke("notes.editor");
  await revoke("notes.viewer");
  await admin("POST", "/admin/v1/apps/notes/deactivate");
});

test("inactive: the gateway serves the unavailable page and proxies nothing", async ({ page, request }) => {
  const res = await page.goto(`${GATEWAY}/`);
  expect(res?.status()).toBe(503);
  await expect(page.getByRole("heading", { name: /temporarily unavailable/i })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g1-inactive-unavailable-page.png` });
  // Even a public path (the app's /api/health) isn't proxied while the app is inactive.
  const health = await browserFetch(page, "GET", "/api/health");
  expect(health.status).toBe(503);
  expect(health.body).toMatchObject({ error: "app_inactive" });
  // The app itself is up: reached directly, it answers. Only the gateway keeps people out.
  expect((await request.get(`${DIRECT}/api/health`)).status()).toBe(200);
});

test("active, signed out: the page is public and sign-in works; a protected route says 401, a browser is sent to sign in", async ({
  page,
}) => {
  expect((await admin("POST", "/admin/v1/apps/notes/activate")).status).toBe(200);
  // Activation is immediate: no restart, no reload.
  const home = await page.goto(`${GATEWAY}/`);
  expect(home?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  const res = await browserFetch(page, "GET", "/api/notes");
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: "unauthenticated", refresh: "/api/asafarim/session" });

  await page.goto(`${GATEWAY}/api/notes`); // gateway 302 → the app's session endpoint → sign-in
  await expect(page).toHaveURL(/\/api\/auth\/signin\?callbackUrl=/);
  await page.screenshot({ path: `${SHOTS}/g2-signed-out-sent-to-sign-in.png` });
});

test("a member without the role: 403 AT the gateway, naming the permission", async ({ page }) => {
  await signInThroughGateway(page, "Dev Member");
  const res = await page.goto(`${GATEWAY}/api/notes`); // 302 → session (mints the token) → back → 403
  expect(res?.status()).toBe(403);
  await expect(page.getByText("notes.read")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g3-member-403-at-the-gateway.png` });

  const json = await api(page, "GET", "/api/notes");
  expect(json.status).toBe(403);
  expect(json.body).toEqual({ error: "forbidden", permission: "notes.read" }); // no `message`: the gateway, not the app
});

test("a viewer reads but can't write (403 at the gateway for the POST); an editor writes", async ({ page }) => {
  await signInThroughGateway(page, "Dev Member");
  expect((await grant("notes.viewer")).body).toMatchObject({ granted: true });
  // The token issued before the grant still says "no permissions" until it expires (≤ its lifetime).
  await untilStatus(page, 200, "GET", "/api/notes", undefined, (TOKEN_TTL + 10) * 1000);
  const denied = await api(page, "POST", "/api/notes", { title: `refused ${RUN}` });
  expect(denied.status).toBe(403);
  expect(denied.body).toEqual({ error: "forbidden", permission: "notes.write" });

  expect((await grant("notes.editor")).body).toMatchObject({ granted: true });
  await untilStatus(
    page,
    201,
    "POST",
    "/api/notes",
    { title: `Gateway note ${RUN}`, body: "through the gateway" },
    (TOKEN_TTL + 10) * 1000,
  );
  const listed = await api(page, "GET", "/api/notes");
  expect((listed.body.notes as { title: string }[]).map((n) => n.title)).toContain(`Gateway note ${RUN}`);
  await page.goto(`${GATEWAY}/`);
  await expect(page.getByTestId("note").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g4-editor-through-the-gateway.png` });
});

test("expose: false is a 404 at the gateway even though the app serves the path", async ({ page, request }) => {
  const direct = await request.get(`${DIRECT}/internal/ping`);
  expect(direct.status()).toBe(200); // the app really serves it
  await page.goto(`${GATEWAY}/`);
  // Plain, doubled-slash and percent-encoded spellings (the browser itself resolves dot segments).
  for (const path of ["/internal/ping", "/internal", "//internal/ping", "/%69nternal/ping", "/internal/ping?x=1"]) {
    const res = await browserFetch(page, "GET", path);
    expect(res.status, path).toBe(404);
  }
});

test("a revoked grant takes effect within the token's lifetime", async ({ page }) => {
  // The member is an editor (granted above); a new test is a new browser, so sign in again.
  await signInThroughGateway(page, "Dev Member");
  await untilStatus(page, 201, "POST", "/api/notes", { title: `before revoke ${RUN}` });
  expect((await revoke("notes.editor")).body).toMatchObject({ revoked: true });
  const started = Date.now();
  const took = await untilStatus(
    page,
    403,
    "POST",
    "/api/notes",
    { title: `after revoke ${RUN}` },
    (TOKEN_TTL + 10) * 1000,
  );
  // The documented bound is the token lifetime; allow a little for the polling itself.
  expect(Date.now() - started, `took ${took} ms`).toBeLessThanOrEqual((TOKEN_TTL + 4) * 1000);
  console.log(`revoked grant effective after ${took} ms (token lifetime ${TOKEN_TTL} s)`);
});

test("deactivating makes the gateway refuse at once, valid token or not", async ({ page }) => {
  await signInThroughGateway(page, "Dev Member");
  await grant("notes.editor");
  await untilStatus(page, 201, "POST", "/api/notes", { title: `last ${RUN}` }, (TOKEN_TTL + 10) * 1000);
  expect((await admin("POST", "/admin/v1/apps/notes/deactivate")).body).toMatchObject({ state: "inactive" });
  // No waiting, no polling: the very next request.
  const res = await browserFetch(page, "GET", "/api/notes");
  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({ error: "app_inactive" });
  const home = await page.goto(`${GATEWAY}/`);
  expect(home?.status()).toBe(503);
  await page.screenshot({ path: `${SHOTS}/g5-deactivated-unavailable.png` });
});
