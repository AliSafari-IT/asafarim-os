/**
 * Flow's slice 1 end to end, through the real bus (`pnpm e2e`): a study note written in Docs with
 * `#issue` reaches Flow as `docs.note.created.v1` and starts a run; Docs drafts the issue
 * (`flow.issue-draft.requested.v1` → `docs.issue-draft.ready.v1`), the owner approves or rejects it
 * under Approvals, and Docs creates it (`flow.issue.approved.v1` → `docs.issue.created.v1` or
 * `docs.issue.failed.v1`). GitHub and Claude are local mocks (e2e/mocks.mjs, started by
 * scripts/dev/e2e.mjs); Docs points at them, and the spec counts the issues the GitHub mock holds.
 *
 * Each test tells its run apart by a marker in its note: the Claude mock puts it in the draft's title.
 * The spec's acceptance criteria, by number, are named in the tests' titles; criterion 6 (a crash
 * after GitHub created the issue) and the redelivery of the same event (7) are fault-injection unit
 * tests in apps/docs/test/issue-create-handler.test.ts: a message can't be redelivered from here.
 *
 * The builder's test (Flow slice 2, PR 2.6) makes a workflow from nothing with the keyboard-reachable
 * controls only (palette, node list, settings panel), validates, publishes and dry-runs it.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const DOCS = process.env.E2E_DOCS_URL ?? "http://localhost:4110";
const GITHUB_MOCK = process.env.E2E_GITHUB_MOCK_URL ?? "http://127.0.0.1:4191";
const SHOTS = "test-results/screens";
const PUBLIC_DOC = "ventures/demo-app/overview.md"; // example-org/demo-app: public in the GitHub mock
const PRIVATE_DOC = "index.md"; // example-org/handbook: private

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

const grant = async (role: string) =>
  expect.poll(() => admin("PUT", `/admin/v1/roles/${role}/grants/dev-member`)).toBeLessThan(300);
const revoke = async (role: string) =>
  expect.poll(() => admin("DELETE", `/admin/v1/roles/${role}/grants/dev-member`)).toBeLessThan(500);

interface MockIssue {
  repo: string;
  number: number;
  html_url: string;
  title: string;
  body: string;
  labels: string[];
}

/** The issues the GitHub mock holds whose title names `marker`. */
async function issuesFor(marker: string): Promise<MockIssue[]> {
  const all = (await (await fetch(`${GITHUB_MOCK}/__issues`)).json()) as MockIssue[];
  return all.filter((i) => i.title.includes(marker));
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
 * Docs, signed in, in a browser context of its own: cookies don't keep ports apart, so Docs' session
 * must not share a jar with Flow's. `fn` gets its page; the context is closed after.
 */
async function inDocs<T>(browser: Browser, fn: (docs: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    const docs = await context.newPage();
    await signIn(docs, DOCS);
    return await fn(docs);
  } finally {
    await context.close();
  }
}

/** A note through Docs' own API; its id. */
async function writeNote(browser: Browser, body: string, docPath = PRIVATE_DOC): Promise<string> {
  return inDocs(browser, async (docs) => {
    const res = await docs.request.post(`${DOCS}/api/notes`, {
      data: { docPath, body },
      headers: { "content-type": "application/json" },
    });
    expect(res.status(), await res.text()).toBe(201);
    return String(((await res.json()) as { note: { id: string } }).note.id);
  });
}

const newMarker = (what: string) => `e2e-${Date.now().toString(36)}-${what}`;

/** The pending approval whose draft names `marker` (Docs drafted it through the bus): its path. */
async function approvalFor(page: Page, marker: string, timeout = 60_000): Promise<string> {
  let found = "";
  await expect(async () => {
    const list = await (await page.request.get("/approvals")).text();
    for (const [, id] of list.matchAll(/href="\/approvals\/([^"]+)"/g)) {
      if ((await (await page.request.get(`/approvals/${id}`)).text()).includes(marker)) {
        found = `/approvals/${id}`;
        return;
      }
    }
    throw new Error(`no approval for ${marker} yet`);
  }).toPass({ timeout, intervals: [500, 1000] });
  return found;
}

/** The run an approval belongs to: its path. */
async function runOf(page: Page, approval: string): Promise<string> {
  await page.goto(approval);
  return (await page.locator('a[href^="/runs/"]').first().getAttribute("href"))!;
}

/** Wait on the Run page until the run is `status`. */
async function runEnds(page: Page, run: string, status: string) {
  await expect(async () => {
    await page.goto(run);
    await expect(page.locator("h1").getByTestId("status")).toHaveText(status, { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
}

const step = (page: Page, key: string) => page.locator(`[data-step="${key}"]`);
/** A step's own status (its approval, if any, has one too). */
const stepStatus = (page: Page, key: string) => step(page, key).locator(".step-head").getByTestId("status");

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
  for (const role of ["docs.owner", "flow.owner", "flow.viewer"])
    await admin("DELETE", `/admin/v1/roles/${role}/grants/dev-member`);
});

test("(1) a #issue note starts a run within seconds; Docs drafts it and the run waits for approval; Cancel stops it", async ({
  page,
  browser,
}) => {
  await signIn(page, "");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const marker = newMarker("cancel");
  await writeNote(browser, `The guide's install step is out of date (${marker}). #issue`);
  // Through the bus: the note's event starts a run, Docs answers the draft request, the run waits on the approval.
  const approval = await approvalFor(page, marker, 20_000);
  const run = await runOf(page, approval);
  await page.goto(run);
  await expect(stepStatus(page, "only-tagged")).toHaveText("succeeded");
  await expect(stepStatus(page, "draft")).toHaveText("succeeded");
  await expect(stepStatus(page, "review")).toHaveText("waiting");
  await expect(step(page, "create")).toContainText("not reached");
  await page.screenshot({ path: `${SHOTS}/run-waiting.png`, fullPage: true });

  await page.getByTestId("cancel").click();
  await expect(page.locator("h1").getByTestId("status")).toHaveText("cancelled");
  await expect(step(page, "review").getByTestId("approval")).toHaveAttribute("data-approval", "cancelled");
  expect(await issuesFor(marker)).toEqual([]);
});

test("(1) a note without the tag starts a skipped run, hidden on Runs unless asked for", async ({ page, browser }) => {
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

test("(2, 3) the draft under Approvals, public banner and all; Approve creates exactly one issue, the note links it, the run succeeds with every step timed", async ({
  page,
  browser,
}) => {
  await signIn(page, "");
  const marker = newMarker("approve");
  await writeNote(browser, `The demo app's overview misses the beta (${marker}). #issue`, PUBLIC_DOC);
  const approval = await approvalFor(page, marker);

  // Listed under Approvals with its document and repository.
  await page.goto("/approvals");
  const row = page.getByTestId("approval").filter({ has: page.locator(`a[href="${approval}"]`) });
  await expect(row).toContainText(PUBLIC_DOC);
  await expect(row).toContainText("example-org/demo-app");

  // The draft: the repository, the public banner, the title, the body and the repo's own labels.
  await page.goto(approval);
  await expect(page.getByTestId("public")).toContainText("This repository is public");
  await expect(page.getByTestId("repo")).toContainText("example-org/demo-app (public)");
  await expect(page.locator("#title")).toHaveValue(`Update the install step (${marker})`);
  await expect(page.locator("#body")).toHaveValue(/## Context[\s\S]*## Done when/);
  await expect(page.locator("#labels")).toHaveValue("docs");
  await page.screenshot({ path: `${SHOTS}/approval-public.png`, fullPage: true });

  await page.locator("#acknowledgedPublic").check();
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("decided")).toContainText("approved");

  const run = await runOf(page, approval);
  await runEnds(page, run, "succeeded");
  for (const key of ["only-tagged", "draft", "review", "create", "end"]) {
    await expect(stepStatus(page, key)).toHaveText("succeeded");
    // Timed: a start, and how long it took.
    await expect(step(page, key).locator("dt:text-is('Took') + dd")).toHaveText(/^\d+ (s|min)/);
  }
  await page.screenshot({ path: `${SHOTS}/run-succeeded.png`, fullPage: true });

  // Exactly one issue on GitHub, the approved one, its body ending with the approval's hidden marker.
  const issues = await issuesFor(marker);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.repo).toBe("example-org/demo-app");
  expect(issues[0]!.labels).toEqual(["docs"]);
  expect(issues[0]!.body).toMatch(/<!-- asafarim-flow:[^ ]+ -->$/);

  // The note shows its issue, "via Flow".
  await inDocs(browser, async (docs) => {
    await docs.goto(`${DOCS}/notes`);
    const note = docs.getByRole("listitem").filter({ hasText: marker });
    await expect(note.getByTestId("issue-link")).toHaveAttribute("href", issues[0]!.html_url);
    await expect(note.getByTestId("via-flow")).toHaveText("via Flow");
    await docs.screenshot({ path: `${SHOTS}/docs-note-via-flow.png`, fullPage: true });
  });
  // Nothing more arrives later (the answer was handled once).
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(await issuesFor(marker)).toHaveLength(1);
});

test("(4) Reject ends the run rejected and creates nothing", async ({ page, browser }) => {
  await signIn(page, "");
  const marker = newMarker("reject");
  await writeNote(browser, `A thought to file maybe (${marker}). #issue`);
  const approval = await approvalFor(page, marker);
  await page.goto(approval);
  // A private repository: no banner, no box to tick.
  await expect(page.getByTestId("repo")).toContainText("example-org/handbook (private)");
  await expect(page.getByTestId("public")).toHaveCount(0);
  await page.locator("#comment").fill("Not worth an issue.");
  await page.getByTestId("reject").click();
  await expect(page.getByTestId("decided")).toContainText("rejected");

  const run = await runOf(page, approval);
  await runEnds(page, run, "rejected");
  await expect(step(page, "review").getByTestId("step-error")).toHaveText("rejected");
  await expect(step(page, "create")).toContainText("not reached");
  expect(await issuesFor(marker)).toEqual([]);
});

test("(5, 10) a note that got an issue meanwhile ends the run failed with issue_exists, code and message on the Run page", async ({
  page,
  browser,
}) => {
  await signIn(page, "");
  const marker = newMarker("exists");
  const noteId = await writeNote(browser, `File this one by hand (${marker}). #issue`);
  const approval = await approvalFor(page, marker);

  // Meanwhile the owner creates the issue from the note in Docs.
  await inDocs(browser, async (docs) => {
    const res = await docs.request.post(`${DOCS}/api/notes/${noteId}/issue`, {
      data: { repo: "example-org/handbook", title: `Filed by hand (${marker})`, body: "By hand.", labels: [] },
      headers: { "content-type": "application/json" },
    });
    expect(res.status(), await res.text()).toBe(201);
  });

  await page.goto(approval);
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("decided")).toContainText("approved");
  const run = await runOf(page, approval);
  await runEnds(page, run, "failed");
  await expect(page.getByTestId("run-error")).toHaveText("issue_exists");
  await expect(step(page, "create").getByTestId("step-error")).toHaveText("issue_exists");
  await expect(step(page, "create")).toContainText("This note already has an issue.");
  await page.screenshot({ path: `${SHOTS}/run-issue-exists.png`, fullPage: true });
  // Only the issue filed by hand.
  const issues = await issuesFor(marker);
  expect(issues.map((i) => i.title)).toEqual([`Filed by hand (${marker})`]);
});

test("(8) without flow.approvals.decide: 403 on the page and on the action", async ({ page, browser }) => {
  await signIn(page, "");
  const marker = newMarker("decide");
  await writeNote(browser, `Someone else decides (${marker}). #issue`);
  const approval = await approvalFor(page, marker);
  // The form, loaded while dev-member may still decide.
  const stale = await page.context().newPage();
  await stale.goto(approval);
  await expect(stale.getByTestId("approve")).toBeVisible();

  await grant("flow.viewer");
  await revoke("flow.owner");
  try {
    await expect(async () => {
      expect((await page.goto("/approvals"))?.status()).toBe(403);
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("forbidden")).toBeVisible();
    expect((await page.goto(approval))?.status()).toBe(403);
    // The action refuses too: back to the approval, which is now a 403.
    await stale.getByTestId("approve").click();
    await expect(stale.getByTestId("forbidden")).toBeVisible();
  } finally {
    await grant("flow.owner");
    await revoke("flow.viewer");
  }
  // Nothing was decided, nothing created.
  await expect(async () => {
    await page.goto(approval);
    await expect(page.getByTestId("approve")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  expect(await issuesFor(marker)).toEqual([]);
  await page.goto(await runOf(page, approval));
  await page.getByTestId("cancel").click();
  await expect(page.locator("h1").getByTestId("status")).toHaveText("cancelled");
});

test("(9, 10) Docs' permission revoked before Approve: the create step fails with forbidden, code and message on the Run page", async ({
  page,
  browser,
}) => {
  await signIn(page, "");
  const marker = newMarker("revoked");
  await writeNote(browser, `File it, then lose the right to (${marker}). #issue`);
  const approval = await approvalFor(page, marker);

  // docs.owner is the role that grants docs.issues.create: without it, Docs refuses to create the issue.
  await revoke("docs.owner");
  try {
    await page.goto(approval);
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("decided")).toContainText("approved");
    const run = await runOf(page, approval);
    await runEnds(page, run, "failed");
    await expect(step(page, "create").getByTestId("step-error")).toHaveText("forbidden");
    await expect(step(page, "create")).toContainText("Missing the permission");
    await page.screenshot({ path: `${SHOTS}/run-forbidden.png`, fullPage: true });
  } finally {
    await grant("docs.owner");
  }
  expect(await issuesFor(marker)).toEqual([]);
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

test("the builder: webhook → condition → email.send → end, validated, published and test-run (dry)", async ({
  page,
}) => {
  await signIn(page, "");
  const key = `built-${Date.now().toString(36)}`;
  const credential = `Mail ${key}`;

  // What the email step needs: an allowed recipient (Settings) and an smtp credential (never used: a dry run).
  await page.goto("/settings");
  const recipients = page.getByTestId("email-recipients").locator("textarea");
  await recipients.fill([await recipients.inputValue(), "ops@example.com"].filter(Boolean).join("\n"));
  await page.getByTestId("email-recipients").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("email-recipients").locator("textarea")).toHaveValue(/ops@example\.com/);
  await page.goto("/credentials");
  const add = page.getByTestId("add-credential");
  await add.getByLabel("Kind", { exact: true }).selectOption("smtp");
  await add.getByLabel("Name", { exact: true }).fill(credential);
  await add.getByLabel("Host", { exact: true }).fill("smtp.example.com");
  await add.getByLabel("From", { exact: true }).fill("flow@example.com");
  await add.getByLabel("Username", { exact: true }).fill("flow");
  await add.getByLabel("Password", { exact: true }).fill("e2e-only");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("credential-saved")).toBeVisible();

  // New workflow, started by a webhook: the builder opens on its first draft.
  await page.goto("/workflows");
  await page.getByTestId("new-workflow").click();
  await page.getByTestId("new-name").fill("Built in the e2e");
  await page.getByTestId("new-key").fill(key);
  await page.getByTestId("new-trigger").selectOption("webhook");
  await page.getByTestId("new-submit").click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${key}/edit$`));
  await expect(page.getByTestId("builder")).toHaveAttribute("data-editable", "true");

  // The trigger's settings: its hook (the Workflows page's hook panel), then an input field.
  await page.getByTestId("create-hook").getByRole("button").click();
  // Its secret, shown once (and kept on screen if the page refreshes to show the hook).
  await expect(page.getByTestId("hook-shown-once")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("hook-url")).toBeVisible();
  const trigger = page.locator(`[data-testid="node-settings"][data-node="@trigger"]`);
  await trigger.getByTestId("trigger-hook").selectOption({ index: 1 });
  await trigger.getByRole("button", { name: "Add input", exact: true }).click();
  await trigger.getByLabel(/^Name/).fill("title");

  // The nodes, from the palette and the settings panel only: no dragging.
  await page.getByTestId("palette-condition").click();
  const condition = page.locator('[data-testid="node-settings"][data-node="condition"]');
  await condition.getByLabel("Field", { exact: true }).fill("trigger.title");
  await condition.getByLabel("Op", { exact: true }).selectOption("contains");
  await condition.getByLabel("Value", { exact: true }).fill("bug");
  // Added after the condition: on its then branch, going on to the end.
  await page.getByTestId("palette-email.send").click();
  const mail = page.locator('[data-testid="node-settings"][data-node="email-send"]');
  await mail.getByLabel(/^Credential/).selectOption({ label: credential });
  await mail.getByLabel(/^To 1/).fill("ops@example.com");
  await mail.getByLabel(/^Subject/).fill("Bug: {{trigger.title}}");
  await mail.getByLabel(/^Body/).fill("{{trigger.title}} was reported.");
  await expect(mail.getByLabel("Then go to")).toHaveValue("end");
  await expect(page.getByTestId("node-list-item")).toHaveCount(4);
  await expect(page.getByTestId("save-state")).toHaveText("Saved");

  await page.getByTestId("validate").click();
  await expect(page.getByTestId("builder-notice")).toHaveText("No problems: it can be published.");
  await page.getByTestId("publish").click();
  await expect(page.getByTestId("builder-notice")).toHaveText(/^Published version 1/);
  await page.screenshot({ path: `${SHOTS}/builder.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/builder-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });

  // Test run: a dry run unless unticked; it opens the run.
  await page.getByTestId("test-run-open").click();
  await expect(page.getByTestId("dry-run")).toBeChecked();
  await page.getByTestId("test-data").fill(JSON.stringify({ title: "a bug found in the e2e" }));
  await page.getByTestId("test-run").click();
  await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
  await runEnds(page, page.url().slice(page.url().indexOf("/runs/")), "succeeded");
  await expect(stepStatus(page, "email-send")).toHaveText("succeeded");

  // Version 1 is on the Versions page.
  await page.goto(`/workflows/${key}/versions`);
  await expect(page.getByTestId("versions")).toContainText("Version 1");
});

test("the builder downloads a workflow export and imports it as a new draft", async ({ page }) => {
  await signIn(page, "");
  const suffix = Date.now().toString(36);
  const sourceKey = `portable-${suffix}`;
  const importedKey = `imported-${suffix}`;

  await page.goto("/workflows");
  await page.getByTestId("new-workflow").click();
  await page.getByTestId("new-name").fill("Portability source");
  await page.getByTestId("new-key").fill(sourceKey);
  await page.getByTestId("new-trigger").selectOption("manual");
  await page.getByTestId("new-submit").click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${sourceKey}/edit$`));
  await expect(page.getByTestId("save-state")).toHaveText("Saved");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-workflow").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${sourceKey}.flow.json`);
  const exported = await readFile((await download.path())!, "utf8");
  expect(JSON.parse(exported)).toMatchObject({
    format: "asafarim.flow.workflow",
    version: 1,
    definition: { version: 2, key: sourceKey },
  });

  const imagePromise = page.waitForEvent("download");
  await page.getByTestId("download-workflow-image").click();
  const image = await imagePromise;
  expect(image.suggestedFilename()).toBe(`${sourceKey}.svg`);
  expect(await readFile((await image.path())!, "utf8")).toContain("<svg");

  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("workflow-diagram")).toBeVisible();
  await expect(page.getByLabel("Numbered workflow outline")).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  await page.getByTestId("import-workflow").click();
  await page.getByTestId("workflow-file-input").setInputFiles({
    name: download.suggestedFilename(),
    mimeType: "application/json",
    buffer: Buffer.from(exported),
  });
  await expect(page.getByTestId("workflow-import-name")).toHaveValue("portable " + suffix);
  await page.getByTestId("workflow-import-key").fill(importedKey);
  await page.getByTestId("confirm-workflow-import").click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${importedKey}/edit$`));
  await expect(page.getByRole("heading", { name: "portable " + suffix })).toBeVisible();
  await expect(page.getByText("not published yet")).toBeVisible();
});
