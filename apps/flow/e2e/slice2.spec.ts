/**
 * Flow slice 2's acceptance workflows end to end (`pnpm e2e`, after flow.spec.ts): each is built in the
 * builder, published, and run for real, against the mocks of e2e/mocks.mjs: GitHub (api.github.com to
 * Flow), an SMTP server (smtp.e2e.test) and a webhook receiver (hooks.e2e.test), reached through Flow's
 * own egress with FLOW_E2E_EGRESS (lib/egress/e2e.ts). Triggers are signed deliveries to POST
 * /hooks/<id>, the way GitHub and a sender call them.
 *
 *   1. GitHub issues.opened → condition (label bug) → email.send; else a skipped end
 *   2. webhook in → approval → github.issue.create → webhook.send
 *   3. GitHub pull_request.closed+merged → github.comment.create → github.labels.add → email.send
 *   4. the gates: a bad signature, a recipient not allowed, a host not allowed, no secret in a page
 *
 * The tests share one set of credentials and settings and run in order.
 */
import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { signatureHeader, verifySignature } from "../lib/connectors/webhook-signature";

const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const MOCK = process.env.E2E_GITHUB_MOCK_URL ?? "http://127.0.0.1:4191";
const SHOTS = "test-results/screens";
const REPO = "example-org/handbook";
const RECIPIENT = "ops@example.com";
const SMTP_PASSWORD = "e2e-smtp-password-7c1d";
const GITHUB_TOKEN = "e2e-github-token-5a9f";
const run = Date.now().toString(36);

test.describe.configure({ mode: "serial" });

/** One call to core-api's admin API; its status (504 when it takes over 3 s, for expect.poll). */
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

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const member = page.getByRole("button", { name: /Dev Member/ });
  await expect(member.or(page.getByTestId("who"))).toBeVisible();
  if (await member.isVisible()) await member.click();
  await expect(page.getByTestId("who")).toBeVisible();
}

/** What the mocks received. */
interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}
const mock = async <T>(what: string): Promise<T> => (await (await fetch(`${MOCK}/__${what}`)).json()) as T;
const mail = () => mock<{ connections: number; messages: Mail[] }>("mail");
const webhooks = () =>
  mock<{ path: string; signature: string | null; delivery: string | null; body: string }[]>("webhooks");
const issues = () => mock<{ repo: string; number: number; title: string; body: string }[]>("issues");
const comments = () => mock<{ repo: string; number: number; body: string }[]>("comments");
const labelsAdded = () => mock<{ repo: string; number: number; labels: string[] }[]>("labels");

/** The secrets this suite makes or types: none may ever be in a page (test 4). */
const secrets: string[] = [SMTP_PASSWORD, GITHUB_TOKEN];
/** Pages to check for them: builders, runs, approvals. */
const pages: string[] = ["/workflows", "/credentials", "/settings", "/runs?skipped=1"];
let callbackSecret = "";

// ---- The builder, by its controls (palette, node list, settings panel): no dragging.

const panel = (page: Page, id: string) => page.locator(`[data-testid="node-settings"][data-node="${id}"]`);
const selectNode = (page: Page, id: string) =>
  page.locator(`[data-testid="node-list-item"][data-node="${id}"]`).click();
const addNode = (page: Page, type: string) => page.getByTestId(`palette-${type}`).click();

async function newWorkflow(page: Page, key: string, trigger: string) {
  await page.goto("/workflows/new");
  await page.getByTestId("new-name").fill(`E2E ${key}`);
  await page.getByTestId("new-key").fill(key);
  await page.getByTestId("new-trigger").selectOption(trigger);
  await page.getByTestId("new-submit").click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${key}/edit$`));
  await expect(page.getByTestId("builder")).toHaveAttribute("data-editable", "true");
  pages.push(`/workflows/${key}/edit`);
}

/** Create the workflow's hook from the trigger's settings and choose it; its id and secret (shown once). */
async function createHook(page: Page): Promise<{ id: string; secret: string }> {
  await page.getByTestId("create-hook").getByRole("button").click();
  const secret = (await page.getByTestId("hook-secret").innerText()).trim();
  expect(secret.length).toBeGreaterThan(20);
  secrets.push(secret);
  await page.reload();
  const url = await page.getByTestId("hook-url").innerText();
  const id = /\/hooks\/([A-Za-z0-9_-]{22})/.exec(url)?.[1];
  expect(id, url).toBeTruthy();
  await panel(page, "@trigger").getByTestId("trigger-hook").selectOption(id!);
  return { id: id!, secret };
}

/** Wait for the autosave, Validate ("No problems"), Publish (version 1). */
async function publish(page: Page) {
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.getByTestId("validate").click();
  await expect(page.getByTestId("builder-notice")).toHaveText("No problems: it can be published.");
  await page.getByTestId("publish").click();
  await expect(page.getByTestId("builder-notice")).toHaveText(/^Published version 1/);
}

/** email.send's settings: the credential by name, one recipient, subject and body. */
async function fillEmail(page: Page, id: string, to: string, subject: string, body: string) {
  const p = panel(page, id);
  await p.getByLabel(/^Credential/).selectOption({ label: `Mail ${run}` });
  await p.getByLabel(/^To 1/).fill(to);
  await p.getByLabel(/^Subject/).fill(subject);
  await p.getByLabel(/^Body/).fill(body);
}

// ---- Deliveries, signed the way the senders sign them.

async function githubDelivery(
  page: Page,
  hook: { id: string; secret: string },
  event: string,
  payload: object,
  opts: { delivery?: string; signature?: string } = {},
) {
  const body = JSON.stringify(payload);
  const signature = opts.signature ?? `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`;
  const res = await page.request.post(`/hooks/${hook.id}`, {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.delivery ?? randomUUID(),
      "x-hub-signature-256": signature,
    },
  });
  return { status: res.status(), json: (await res.json()) as Record<string, unknown> };
}

async function genericDelivery(page: Page, hook: { id: string; secret: string }, payload: object) {
  const body = JSON.stringify(payload);
  const res = await page.request.post(`/hooks/${hook.id}`, {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-flow-signature": signatureHeader(hook.secret, body, Math.floor(Date.now() / 1000)),
      "x-flow-delivery": randomUUID(),
    },
  });
  return { status: res.status(), json: (await res.json()) as Record<string, unknown> };
}

// ---- Runs.

const step = (page: Page, key: string) => page.locator(`[data-step="${key}"]`);
const stepStatus = (page: Page, key: string) => step(page, key).locator(".step-head").getByTestId("status");

/** Wait on the Run page until the run is `status`. */
async function runEnds(page: Page, runId: string, status: string) {
  pages.push(`/runs/${runId}`);
  await expect(async () => {
    await page.goto(`/runs/${runId}`);
    await expect(page.locator("h1").getByTestId("status")).toHaveText(status, { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
}

const started = (r: { status: number; json: Record<string, unknown> }) => {
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(typeof r.json.runId).toBe("string");
  return r.json.runId as string;
};

test.beforeAll(async () => {
  expect(ADMIN_TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  expect([200, 409]).toContain(await admin("POST", "/admin/v1/apps/flow/activate"));
  await expect
    .poll(() => admin("PUT", "/admin/v1/roles/flow.owner/grants/dev-member"), { timeout: 30_000 })
    .toBeLessThan(300);
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

test.afterAll(async () => {
  await admin("DELETE", "/admin/v1/roles/flow.owner/grants/dev-member");
});

test("setup: the allow-lists and the credentials the workflows use", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  for (const [list, entry] of [
    ["email-recipients", RECIPIENT],
    ["egress-hosts", "hooks.e2e.test"],
  ] as const) {
    const area = page.getByTestId(list).locator("textarea");
    const now = await area.inputValue();
    if (!now.split(/\s+/).includes(entry)) {
      await area.fill([now, entry].filter(Boolean).join("\n"));
      await page.getByTestId(list).getByRole("button", { name: "Save", exact: true }).click();
    }
    await expect(page.getByTestId(list).locator("textarea")).toHaveValue(new RegExp(entry.replace(/\./g, "\\.")));
  }

  await page.goto("/credentials");
  const add = page.getByTestId("add-credential");
  const submit = async () => {
    await add.getByRole("button", { name: "Add", exact: true }).click();
  };
  // SMTP over TLS to smtp.e2e.test (the mock), 465.
  await add.getByLabel("Kind", { exact: true }).selectOption("smtp");
  await add.getByLabel("Name", { exact: true }).fill(`Mail ${run}`);
  await add.getByLabel("Host", { exact: true }).fill("smtp.e2e.test");
  await add.getByLabel("Port", { exact: true }).fill("465");
  await add.getByLabel("Mode", { exact: true }).selectOption("tls");
  await add.getByLabel("From", { exact: true }).fill("flow@example.com");
  await add.getByLabel("Username", { exact: true }).fill("flow");
  await add.getByLabel("Password", { exact: true }).fill(SMTP_PASSWORD);
  await submit();
  await expect(page.getByTestId("credential-saved")).toBeVisible();
  // A GitHub token for the repo the workflows act on.
  await page.goto("/credentials");
  await add.getByLabel("Kind", { exact: true }).selectOption("github-token");
  await add.getByLabel("Name", { exact: true }).fill(`GitHub ${run}`);
  await add.getByLabel("Allowed repositories", { exact: true }).fill(REPO);
  await add.getByLabel("Token", { exact: true }).fill(GITHUB_TOKEN);
  await submit();
  await expect(page.getByTestId("credential-saved")).toBeVisible();
  // The callback's signing secret: generated, shown once.
  await page.goto("/credentials");
  await add.getByLabel("Kind", { exact: true }).selectOption("webhook-secret");
  await add.getByLabel("Name", { exact: true }).fill(`Callback ${run}`);
  await submit();
  callbackSecret = (await page.getByTestId("secret").innerText()).trim();
  expect(callbackSecret.length).toBeGreaterThan(20);
  secrets.push(callbackSecret);
});

test("(1) GitHub issues.opened → a bug is emailed; another issue ends on the else branch; a redelivery starts nothing", async ({
  page,
}) => {
  await signIn(page);
  const key = `e2e-bug-mail-${run}`;
  await newWorkflow(page, key, "github");
  const hook = await createHook(page);
  const trigger = panel(page, "@trigger");
  await trigger.getByLabel(/^Repos 1/).fill(REPO);
  await trigger.getByLabel(/^Events 1/).fill("issues.opened");

  await addNode(page, "condition");
  const condition = panel(page, "condition");
  await condition.getByLabel("Field", { exact: true }).fill("trigger.labels");
  await condition.getByLabel("Op", { exact: true }).selectOption("contains");
  await condition.getByLabel("Value", { exact: true }).fill("bug");
  await addNode(page, "email.send"); // after the condition: on its then branch
  await fillEmail(page, "email-send", RECIPIENT, "New bug: {{trigger.issue.title}}", "{{trigger.issue.html_url}}");
  // The else branch: an end of its own, which ends the run skipped.
  await selectNode(page, "end");
  await addNode(page, "end");
  await panel(page, "end-2")
    .getByLabel(/^Status/)
    .selectOption("skipped");
  await selectNode(page, "condition");
  await panel(page, "condition").getByLabel("Otherwise, go to").selectOption("end-2");
  await publish(page);

  const issue = (n: number, title: string, labels: string[]) => ({
    action: "opened",
    repository: { full_name: REPO },
    issue: {
      number: n,
      title,
      html_url: `https://github.com/${REPO}/issues/${n}`,
      labels: labels.map((name) => ({ name })),
    },
    sender: { login: "octocat" },
  });
  const bugTitle = `Crash on save (${run})`;
  const delivery = randomUUID();
  const before = (await mail()).messages.length;
  const bugRun = started(await githubDelivery(page, hook, "issues", issue(101, bugTitle, ["bug", "ui"]), { delivery }));
  await runEnds(page, bugRun, "succeeded");
  await expect(stepStatus(page, "email-send")).toHaveText("succeeded");
  const sent = (await mail()).messages.filter((m) => m.subject === `New bug: ${bugTitle}`);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toEqual([RECIPIENT]);
  expect(sent[0]!.text).toBe(`https://github.com/${REPO}/issues/101`);

  // The same X-GitHub-Delivery again: no second run.
  const again = await githubDelivery(page, hook, "issues", issue(101, bugTitle, ["bug", "ui"]), { delivery });
  expect([again.status, again.json]).toEqual([200, { duplicate: true }]);

  // An issue without "bug": the else branch, nothing sent.
  const otherRun = started(await githubDelivery(page, hook, "issues", issue(102, `A question (${run})`, ["question"])));
  await runEnds(page, otherRun, "skipped");
  await expect(step(page, "email-send")).toContainText("not reached");
  await expect(stepStatus(page, "end-2")).toHaveText("succeeded");
  expect((await mail()).messages.length).toBe(before + 1);
});

test("(2) webhook in → approval (showing the payload) → GitHub issue → signed webhook out; a rejection creates nothing", async ({
  page,
}) => {
  await signIn(page);
  const key = `e2e-approve-${run}`;
  await newWorkflow(page, key, "webhook");
  const hook = await createHook(page);
  const trigger = panel(page, "@trigger");
  await trigger.getByRole("button", { name: "Add input", exact: true }).click();
  await trigger.getByLabel(/^Name/).fill("title");

  await addNode(page, "approval");
  await addNode(page, "github.issue.create");
  const create = panel(page, "github-issue-create");
  await create.getByLabel(/^Credential/).selectOption({ label: `GitHub ${run}` });
  await create.getByLabel(/^Repo/).fill(REPO);
  await create.getByLabel(/^Title/).fill("{{trigger.title}}");
  await addNode(page, "webhook.send");
  const out = panel(page, "webhook-send");
  await out.getByLabel(/^Url/).fill("https://hooks.e2e.test/callback");
  await out.getByLabel(/^Credential/).selectOption({ label: `Callback ${run}` });
  await out.getByLabel(/^Body/).fill('{"issue": "{{steps.github-issue-create.output.url}}"}');
  await publish(page);
  await page.screenshot({ path: `${SHOTS}/slice2-approval-flow.png`, fullPage: true });

  /** Deliver, open the approval from the run, check it shows the payload, decide. */
  async function decide(title: string, decision: "approve" | "reject") {
    const runId = started(await genericDelivery(page, hook, { title }));
    await runEnds(page, runId, "waiting");
    await step(page, "approval").getByRole("link", { name: "Review it" }).click();
    pages.push(new URL(page.url()).pathname);
    await expect(page.getByTestId("payload")).toContainText(title);
    await page.getByTestId(decision).click();
    return runId;
  }

  const approvedTitle = `Approved in the e2e (${run})`;
  const approvedRun = await decide(approvedTitle, "approve");
  await runEnds(page, approvedRun, "succeeded");
  const made = (await issues()).filter((i) => i.title === approvedTitle);
  expect(made).toHaveLength(1);
  expect(made[0]!.repo).toBe(REPO);
  expect(made[0]!.body).toContain("<!-- asafarim-flow:");
  const posts = (await webhooks()).filter((w) => w.delivery === `${approvedRun}:webhook-send`);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe("/callback");
  expect(JSON.parse(posts[0]!.body)).toEqual({
    issue: `https://github.com/${REPO}/issues/${made[0]!.number}`,
  });
  expect(
    verifySignature(callbackSecret, posts[0]!.signature ?? undefined, posts[0]!.body, Math.floor(Date.now() / 1000)),
  ).toBe(true);

  const rejectedTitle = `Rejected in the e2e (${run})`;
  const rejectedRun = await decide(rejectedTitle, "reject");
  await runEnds(page, rejectedRun, "rejected");
  expect((await issues()).filter((i) => i.title === rejectedTitle)).toEqual([]);
  expect((await webhooks()).filter((w) => w.delivery === `${rejectedRun}:webhook-send`)).toEqual([]);
});

test("(3) a merged pull request → comment, label and email; a closed one that wasn't merged is filtered", async ({
  page,
}) => {
  await signIn(page);
  const key = `e2e-merged-${run}`;
  await newWorkflow(page, key, "github");
  const hook = await createHook(page);
  const trigger = panel(page, "@trigger");
  await trigger.getByLabel(/^Repos 1/).fill(REPO);
  await trigger.getByLabel(/^Events 1/).fill("pull_request.closed+merged");

  await addNode(page, "github.comment.create");
  const comment = panel(page, "github-comment-create");
  await comment.getByLabel(/^Credential/).selectOption({ label: `GitHub ${run}` });
  await comment.getByLabel(/^Repo/).fill(REPO);
  await comment.getByLabel(/^Number/).fill("{{trigger.pull_request.number}}");
  await comment.getByLabel(/^Body/).fill("Released in the next deploy");
  await addNode(page, "github.labels.add");
  const label = panel(page, "github-labels-add");
  await label.getByLabel(/^Credential/).selectOption({ label: `GitHub ${run}` });
  await label.getByLabel(/^Repo/).fill(REPO);
  await label.getByLabel(/^Number/).fill("{{trigger.pull_request.number}}");
  await label.getByLabel(/^Labels 1/).fill("merged");
  await addNode(page, "email.send");
  await fillEmail(
    page,
    "email-send",
    RECIPIENT,
    "Merged: {{trigger.pull_request.title}}",
    "{{trigger.pull_request.html_url}}",
  );
  await publish(page);

  const number = 4000 + Math.floor(Math.random() * 5000);
  const title = `Ship it (${run})`;
  const pr = (merged: boolean) => ({
    action: "closed",
    repository: { full_name: REPO },
    pull_request: { number, title, merged, html_url: `https://github.com/${REPO}/pull/${number}`, labels: [] },
  });
  const runId = started(await githubDelivery(page, hook, "pull_request", pr(true)));
  await runEnds(page, runId, "succeeded");
  for (const k of ["github-comment-create", "github-labels-add", "email-send"])
    await expect(stepStatus(page, k)).toHaveText("succeeded");
  const posted = (await comments()).filter((c) => c.repo === REPO && c.number === number);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.body.startsWith("Released in the next deploy")).toBe(true);
  expect((await labelsAdded()).filter((l) => l.number === number).flatMap((l) => l.labels)).toEqual(["merged"]);
  expect((await mail()).messages.filter((m) => m.subject === `Merged: ${title}`)).toHaveLength(1);

  // Closed without merging: the trigger doesn't take it.
  const closed = await githubDelivery(page, hook, "pull_request", pr(false));
  expect([closed.status, closed.json]).toEqual([202, { started: false, reason: "filtered" }]);
});

test("(4) the gates: a bad signature, a recipient not allowed, a host not allowed; no secret in any page", async ({
  page,
}) => {
  await signIn(page);
  // A bad signature: 401, and no run (the same delivery, signed right, then starts one).
  const key = `e2e-gates-${run}`;
  await newWorkflow(page, key, "webhook");
  const hook = await createHook(page);
  await addNode(page, "email.send");
  await fillEmail(page, "email-send", RECIPIENT, "Gate", "Gate");
  await publish(page);
  const body = JSON.stringify({});
  const bad = await page.request.post(`/hooks/${hook.id}`, {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-flow-signature": signatureHeader("not-the-secret", body, Math.floor(Date.now() / 1000)),
    },
  });
  expect([bad.status(), await bad.json()]).toEqual([401, { error: "rejected" }]);
  await page.goto("/runs?skipped=1");
  await expect(page.getByTestId("run").filter({ hasText: key })).toHaveCount(0);

  // A recipient not allowed (a placeholder, so only the run can tell): the step fails before any
  // connection to the mail server.
  const mailKey = `e2e-gate-mail-${run}`;
  await newWorkflow(page, mailKey, "manual");
  const trigger = panel(page, "@trigger");
  await trigger.getByRole("button", { name: "Add input", exact: true }).click();
  await trigger.getByLabel(/^Name/).fill("to");
  await addNode(page, "email.send");
  await fillEmail(page, "email-send", "{{trigger.to}}", "Gate", "Gate");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  const connections = (await mail()).connections;
  await page.getByTestId("test-run-open").click();
  await page.getByTestId("dry-run").uncheck();
  await page.getByTestId("test-data").fill(JSON.stringify({ to: "eve@elsewhere.example" }));
  await page.getByTestId("test-run").click();
  await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
  const mailRun = page.url().split("/runs/")[1]!;
  await runEnds(page, mailRun, "failed");
  await expect(step(page, "email-send").getByTestId("step-error")).toHaveText("recipient_not_allowed");
  expect((await mail()).connections).toBe(connections);

  // A webhook host not on egress_hosts: refused by egress, nothing reaches the receiver.
  const hookKey = `e2e-gate-host-${run}`;
  await newWorkflow(page, hookKey, "manual");
  await addNode(page, "webhook.send");
  const out = panel(page, "webhook-send");
  await out.getByLabel(/^Url/).fill("https://elsewhere.e2e.test/callback");
  await out.getByLabel(/^Credential/).selectOption({ label: `Callback ${run}` });
  await out.getByLabel(/^Body/).fill("{}");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  const received = (await webhooks()).length;
  await page.getByTestId("test-run-open").click();
  await page.getByTestId("dry-run").uncheck();
  await page.getByTestId("test-data").fill("{}");
  await page.getByTestId("test-run").click();
  await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
  const hostRun = page.url().split("/runs/")[1]!;
  await runEnds(page, hostRun, "failed");
  await expect(step(page, "webhook-send").getByTestId("step-error")).toHaveText("host_not_allowed");
  expect((await webhooks()).length).toBe(received);

  // No secret in any page this suite opened, nor the lists (the HTML as served, not what's visible).
  expect(secrets.length).toBeGreaterThanOrEqual(6);
  for (const path of new Set(pages)) {
    const html = await (await page.request.get(path)).text();
    for (const secret of secrets) expect(html.includes(secret), `${path} has a secret`).toBe(false);
  }
});
