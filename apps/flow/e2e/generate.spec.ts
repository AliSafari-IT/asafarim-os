/**
 * "Generate from issue" (#283) in a real browser, against the e2e's mocks (apps/flow/e2e/mocks.mjs):
 * GitHub's issue example-org/flow-requests#7 and Claude, both reached through lib/egress
 * (FLOW_E2E_EGRESS). No live network, no real key.
 *
 * Off by default; an admin turns it on (Settings, with the disclosure); a public issue becomes a draft
 * that opens in the builder with the banner and the AI's notes, its webhook left unconfigured although
 * the issue asks for an attacker's host; a look-alike URL is refused before anything is sent; turned off
 * again, the action is disabled.
 */
import { expect, test, type Page } from "@playwright/test";

const GITHUB_MOCK = process.env.E2E_GITHUB_MOCK_URL ?? "http://127.0.0.1:4191";
const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const ISSUE_URL = "https://github.com/example-org/flow-requests/issues/7";
const INJECTED_HOST = "collect.evil.example";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const member = page.getByRole("button", { name: /Dev Member/ });
  await expect(member.or(page.getByTestId("who"))).toBeVisible();
  if (await member.isVisible()) await member.click();
  await expect(page.getByTestId("who")).toBeVisible();
}

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

// flow.owner holds flow.workflows.generate and flow.settings.write (platform.app.ts).
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

/** Turn AI drafting on or off on the Settings page. */
async function setAi(page: Page, on: boolean) {
  await page.goto("/settings");
  const section = page.getByTestId("ai-generation");
  if ((await section.getAttribute("data-enabled")) !== (on ? "on" : "off"))
    await section.getByTestId("toggle-ai-generation").click();
  await expect(page.getByTestId("ai-generation")).toHaveAttribute("data-enabled", on ? "on" : "off");
}

const aiCalls = async () =>
  (await (await fetch(`${GITHUB_MOCK}/__ai`)).json()) as { tools: boolean; structured: boolean; sawIssue: boolean }[];

test("Generate from issue: off by default; a public issue becomes a reviewed draft with nothing outbound configured", async ({
  page,
}) => {
  await signIn(page);
  await setAi(page, false);

  // Off: offered, but disabled, with why; building by hand still works.
  await page.goto("/workflows/new");
  await expect(page.getByTestId("generate-unavailable")).toContainText("Turned off");
  await expect(page.getByTestId("generate-submit")).toBeDisabled();
  await expect(page.getByTestId("new-submit")).toBeEnabled();

  // An admin turns it on; the page says what leaves.
  await setAi(page, true);
  await expect(page.getByTestId("ai-generation")).toContainText("sent to an external AI provider, Anthropic");

  // A look-alike host is refused before anything is sent.
  const before = (await aiCalls()).length;
  await page.goto("/workflows/new");
  await page.getByTestId("generate-url").fill("https://github.com.evil.example/example-org/flow-requests/issues/7");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("error")).toContainText("isn't an issue URL Flow can read");
  expect((await aiCalls()).length).toBe(before);

  // The real issue: a draft, in the builder, never published.
  await page.getByTestId("generate-url").fill(ISSUE_URL);
  await page.getByTestId("generate-submit").click();
  await expect(page).toHaveURL(/\/workflows\/gen-flow-requests-7-[a-z0-9]{6}\/edit\?generated=1$/, { timeout: 60_000 });
  const banner = page.getByTestId("generated-banner");
  await expect(banner).toContainText("AI-generated draft, review before saving.");
  await expect(banner.getByRole("link", { name: "example-org/flow-requests#7" })).toHaveAttribute("href", ISSUE_URL);
  await expect(page.getByTestId("node-list-item")).toHaveCount(4); // the trigger and three nodes

  // The AI's note, on the node it is about.
  await page.locator('[data-testid="node-list-item"][data-node="approve-release"]').click();
  await expect(page.getByTestId("generated-note")).toContainText("release manager");

  // The webhook arrives unconfigured: the builder flags it, and the attacker's host is nowhere.
  await page.locator('[data-testid="node-list-item"][data-node="call-deploy-hook"]').click();
  await expect(page.locator('[data-testid="node-list-item"][data-node="call-deploy-hook"] .badge')).toBeVisible();
  expect(await page.content()).not.toContain(INJECTED_HOST);

  // Claude got the issue as data, with no tools, and a JSON-schema answer format.
  const calls = (await aiCalls()).slice(before);
  expect(calls).toEqual([{ tools: false, structured: true, sawIssue: true }]);

  // Off again: disabled.
  await setAi(page, false);
  await page.goto("/workflows/new");
  await expect(page.getByTestId("generate-submit")).toBeDisabled();
});
