/**
 * Flow's slice 1 through the real bus (`pnpm e2e`): a study note written in Docs with `#issue` reaches
 * Flow as `docs.note.created.v1` (Docs' outbox → JetStream → Flow's inbox) and starts a run that waits
 * on its draft step, its request in Flow's outbox; a note without the tag starts a run that is
 * skipped (hidden on Runs unless asked for); Cancel stops a run; the Approvals page opens for the
 * owner. Docs doesn't answer the draft request on main yet, so the run stays waiting on its draft (the
 * approval itself is covered by the unit and integration tests).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const DOCS = process.env.E2E_DOCS_URL ?? "http://localhost:4110";
const SHOTS = "test-results/screens";

/**
 * One call to core-api's admin API; its status. Bounded to 3 s: a call that times out answers 504, so
 * `expect.poll` tries again instead of hanging. Any other error is thrown.
 */
async function admin(method: string, p: string) {
  try {
    const res = await fetch(`${CORE_API}${p}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.status;
  } catch (err) {
    if ((err as Error).name === "TimeoutError") return 504;
    throw err;
  }
}

/** Sign in through identity and the dev login stub as dev-member, on `base` (identity may remember them). */
async function signIn(page: Page, base: string) {
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  const member = page.getByRole("button", { name: /Dev Member/ });
  await expect(member.or(page.getByTestId("who"))).toBeVisible();
  if (await member.isVisible()) await member.click();
  await expect(page.getByTestId("who")).toBeVisible();
}

/**
 * A note on Docs' fixture index, through Docs' own API, in a browser context of its own: cookies
 * don't keep ports apart, so Docs' session must not share a jar with Flow's.
 */
async function writeNote(browser: Browser, body: string) {
  const context = await browser.newContext();
  try {
    const docs = await context.newPage();
    await signIn(docs, DOCS);
    const res = await docs.request.post(`${DOCS}/api/notes`, {
      data: { docPath: "index.md", body },
      headers: { "content-type": "application/json" },
    });
    expect(res.status(), await res.text()).toBe(201);
  } finally {
    await context.close();
  }
}

test.beforeAll(async () => {
  expect(ADMIN_TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  for (const app of ["docs", "flow"])
    expect([200, 409]).toContain(await admin("POST", `/admin/v1/apps/${app}/activate`));
  // flow.owner exists once Flow has registered (on boot, in the background): wait for it.
  for (const role of ["docs.owner", "flow.owner"]) {
    await expect
      .poll(() => admin("PUT", `/admin/v1/roles/${role}/grants/dev-member`), { timeout: 30_000 })
      .toBeLessThan(300);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

test.afterAll(async () => {
  for (const role of ["docs.owner", "flow.owner"]) await admin("DELETE", `/admin/v1/roles/${role}/grants/dev-member`);
});

test("a #issue note in Docs starts a run that waits on the draft step; Cancel stops it", async ({ page, browser }) => {
  await signIn(page, "");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const marker = `e2e-${Date.now()}`;
  await writeNote(browser, `The guide's install step is out of date (${marker}). #issue`);

  // Through the bus: poll the Overview until the run waits.
  await expect(async () => {
    await page.goto("/");
    await expect(page.getByTestId("waiting").getByTestId("run").first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const run = page.getByTestId("waiting").getByTestId("run").first();
  await expect(run).toContainText("docs-note-to-issue");
  await expect(run).toContainText("draft");
  await page.screenshot({ path: `${SHOTS}/overview.png`, fullPage: true });

  await run.getByRole("link").click();
  await expect(page.locator('[data-step="only-tagged"]').getByTestId("status")).toHaveText("succeeded");
  await expect(page.locator('[data-step="draft"]').getByTestId("status")).toHaveText("waiting");
  await expect(page.locator('[data-step="review"]')).toContainText("not reached");
  await page.screenshot({ path: `${SHOTS}/run-waiting.png`, fullPage: true });

  await page.getByTestId("cancel").click();
  await expect(page.locator("h1").getByTestId("status")).toHaveText("cancelled");
  await expect(page.locator('[data-step="draft"]').getByTestId("status")).toHaveText("skipped");
});

test("a note without the tag starts a skipped run, hidden on Runs unless asked for", async ({ page, browser }) => {
  await signIn(page, "");
  await page.goto("/runs");
  const before = await page.getByTestId("run").count();
  await writeNote(browser, "Nothing to file here, just a thought.");

  await expect(async () => {
    await page.goto("/runs?skipped=1");
    await expect(page.getByTestId("run").filter({ hasText: "skipped" }).first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await page.goto("/runs");
  await expect(page.getByTestId("run").filter({ hasText: "skipped" })).toHaveCount(0);
  expect(await page.getByTestId("run").count()).toBe(before);
});

test("Approvals: the owner may decide; the Overview counts what waits for them", async ({ page }) => {
  await signIn(page, "");
  await expect(page.getByTestId("pending-approvals")).toBeVisible();
  await page.getByRole("navigation", { name: "Flow" }).getByRole("link", { name: "Approvals" }).click();
  await expect(page.getByRole("heading", { name: /Approvals/ })).toBeVisible();
  await expect(page.getByTestId("approvals").or(page.getByTestId("approvals-empty"))).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/approvals.png`, fullPage: true });
});

test("Workflows shows the definition read-only; the owner pauses and resumes it", async ({ page }) => {
  await signIn(page, "");
  await page.goto("/workflows");
  const wf = page.locator('[data-workflow="docs-note-to-issue"]');
  await expect(wf.getByTestId("definition")).toContainText('"event": "docs.note.created.v1"');
  await wf.getByTestId("toggle").click();
  await expect(wf.getByTestId("status")).toHaveText("paused");
  await page.screenshot({ path: `${SHOTS}/workflows.png`, fullPage: true });
  await wf.getByTestId("toggle").click();
  await expect(wf.getByTestId("status")).toHaveText("active");
});
