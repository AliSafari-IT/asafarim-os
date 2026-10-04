/**
 * The P3.3b acceptance flow, in a real browser against the real stack (identity, the dev login stub,
 * core-api, Postgres, the dev gateway, notes and the Admin console):
 *
 *   a non-admin opening /admin → 403 →
 *   the admin signs in → activates notes (a styled dialog, never window.confirm) →
 *   grants notes.editor to the member → the member's launcher shows Notes and they can write →
 *   the admin deactivates notes → it disappears from the launcher →
 *   every admin action is in the audit log under the admin's own name →
 *   keyboard, labels and light/dark checks on the console.
 *
 * The console is reached at http://core.localhost:8080 (the gateway), notes at http://notes.localhost:8080.
 * The FIRST administrator is made by the CLI token (what `platform role grant core.admin dev-admin` does):
 * nothing self-grants core.admin.
 */
import { signRequest } from "@asafarim/registry-protocol";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

const ADMIN = process.env.E2E_ADMIN_URL ?? "http://core.localhost:8080";
const NOTES = process.env.E2E_GATEWAY_URL ?? "http://notes.localhost:8080";
const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
// notes' registry credential, from the e2e runner (it reads .dev/notes.env): the spec itself reads no files.
const NOTES_CREDENTIAL = process.env.E2E_NOTES_CREDENTIAL ?? "";
const SHOTS = "test-results/screens";

async function cli(method: string, path: string) {
  const res = await fetch(`${CORE_API}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const grant = (role: string, sub: string) => cli("PUT", `/admin/v1/roles/${role}/grants/${sub}`);
const revoke = (role: string, sub: string) => cli("DELETE", `/admin/v1/roles/${role}/grants/${sub}`);

/** What notes (an app) gets from core-api's launcher endpoint for a person: the same signed call the SDK makes. */
async function launcherFor(sub: string): Promise<string[]> {
  expect(NOTES_CREDENTIAL, "E2E_NOTES_CREDENTIAL must be set (pnpm e2e sets it)").not.toBe("");
  const path = `/registry/v1/apps/notes/launcher/${encodeURIComponent(sub)}`;
  const res = await fetch(`${CORE_API}${path}`, {
    headers: signRequest({ credential: NOTES_CREDENTIAL, method: "GET", path }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { apps: { key: string }[] }).apps.map((a) => a.key);
}

/**
 * Sign in through identity and the dev login stub as one of the seeded users. A browser that already
 * has an identity session (single sign-on) skips the user chooser and lands straight back, so wait
 * for whichever comes first.
 */
async function signIn(page: Page, url: string, displayName: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in" }).click();
  const chooser = page.getByRole("button", { name: new RegExp(displayName) });
  const signedIn = page.getByTestId("who");
  await expect(chooser.or(signedIn)).toBeVisible({ timeout: 20_000 });
  if (await chooser.isVisible()) await chooser.click();
  await expect(signedIn).toBeVisible();
}

async function openApps(page: Page) {
  await page.goto(`${ADMIN}/admin/apps`);
  await expect(page.getByRole("heading", { level: 2, name: "Apps" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

let adminCtx: BrowserContext;
let memberCtx: BrowserContext;
let nativeDialogs = 0;
let startId = 0;
const RUN = Date.now().toString(36);

async function newContext(browser: Browser) {
  const ctx = await browser.newContext();
  // A native alert/confirm/prompt is a failure: the console uses its own styled dialog.
  ctx.on("page", (p) => p.on("dialog", (d) => (nativeDialogs++, void d.dismiss())));
  return ctx;
}

test.beforeAll(async ({ browser }) => {
  expect(TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  // Re-runnable: the first administrator is made by the CLI (the bootstrap); nobody else holds anything.
  await grant("core.admin", "dev-admin");
  await revoke("core.admin", "dev-member");
  await revoke("notes.editor", "dev-member");
  await revoke("notes.viewer", "dev-member");
  await cli("POST", "/admin/v1/apps/notes/deactivate");
  startId =
    (
      (await (
        await fetch(`${CORE_API}/admin/v1/audit?limit=1`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json()) as { events: { id: number }[] }
    ).events[0]?.id ?? 0;
  adminCtx = await newContext(browser);
  memberCtx = await newContext(browser);
});

test.afterAll(async () => {
  await revoke("notes.editor", "dev-member");
  await cli("POST", "/admin/v1/apps/notes/deactivate");
  await adminCtx?.close();
  await memberCtx?.close();
  expect(nativeDialogs, "the console must never use window.alert/confirm/prompt").toBe(0);
});

test("signed out, /admin sends you to sign in; a signed-in non-admin gets a 403", async () => {
  const page = await memberCtx.newPage();
  await page.goto(`${ADMIN}/admin`);
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "ASafariM OS Admin" })).toBeVisible();

  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Dev Member/ }).click();
  // After sign-in the member lands on /admin: a real 403 with the reason, and no console.
  await expect(page.getByRole("heading", { name: /403/ })).toBeVisible();
  const again = await page.goto(`${ADMIN}/admin/apps`);
  expect(again?.status()).toBe(403);
  await expect(page.getByText("core.admin").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/a1-non-admin-403.png` });
  // The admin pages answer 403 for every section, not just the first.
  for (const path of ["/admin", "/admin/roles", "/admin/audit"]) {
    expect((await page.goto(`${ADMIN}${path}`))?.status(), path).toBe(403);
  }
  await page.close();
});

test("the admin signs in and activates notes through a styled dialog", async () => {
  const page = await adminCtx.newPage();
  await signIn(page, `${ADMIN}/admin`, "Dev Admin");
  await expect(page.getByTestId("who")).toContainText("dev-admin"); // the subject: what the audit log calls them
  await openApps(page);
  await expect(page.getByTestId("app-core")).toContainText("Always active"); // built in: no action
  await expect(page.getByTestId("state-notes")).toHaveText(/installed|inactive/);
  await page.screenshot({ path: `${SHOTS}/a2-apps-before.png` });

  await page.getByRole("button", { name: "Activate Notes" }).click();
  const dialog = page.getByRole("dialog", { name: "Activate Notes?" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/a3-activate-dialog.png` });
  await dialog.getByRole("button", { name: "Activate", exact: true }).click();

  await expect(page.getByTestId("flash-notice")).toContainText("notes is active");
  await expect(page.getByTestId("state-notes")).toHaveText("active");
  await page.screenshot({ path: `${SHOTS}/a4-apps-after-activate.png` });
  await page.close();
});

test("the admin grants notes.editor to the member", async () => {
  const page = await adminCtx.newPage();
  await page.goto(`${ADMIN}/admin/roles?app=notes`);
  await expect(page.getByRole("heading", { level: 2, name: "Roles & grants" })).toBeVisible();
  await expect(page.getByTestId("role-notes.editor")).toContainText("notes.write");
  // Cancelling does nothing.
  const member = page.getByTestId("person-dev-member");
  await expect(member).toBeVisible();
  await member.getByLabel("Role for Dev Member").selectOption("notes.editor");
  await member.getByRole("button", { name: /Grant the selected role to Dev Member/ }).click();

  await expect(page.getByTestId("flash-notice")).toContainText("Granted notes.editor to dev-member");
  await expect(page.getByTestId("holder-notes.editor-dev-member")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/a5-role-granted.png` });
  // Granting again is harmless and says so.
  await member.getByLabel("Role for Dev Member").selectOption("notes.editor");
  await member.getByRole("button", { name: /Grant the selected role to Dev Member/ }).click();
  await expect(page.getByTestId("flash-notice")).toContainText("already holds");
  await page.close();
});

test("the member's launcher shows Notes, and they can write", async () => {
  expect(await launcherFor("dev-member")).toContain("notes"); // what core-api answers
  const page = await memberCtx.newPage();
  await signIn(page, NOTES, "Dev Member");
  await expect(page.getByTestId("who")).toContainText("dev-member");
  // (the permission lookup is cached for a second in development)
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

  const launcher = page.getByRole("navigation", { name: "Your apps" });
  await expect(launcher.getByRole("link", { name: /Notes/ })).toBeVisible();
  await expect(launcher.getByRole("link", { name: /Notes/ })).toHaveAttribute("aria-current", "page");
  await expect(launcher.getByRole("link", { name: /Notes/ })).toHaveAttribute(
    "href",
    /^http:\/\/notes\.localhost:8080\/?$/,
  );
  await page.screenshot({ path: `${SHOTS}/a6-member-launcher.png` });

  await page.getByLabel("Title").fill(`Written after the grant ${RUN}`);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("note").first()).toContainText(`Written after the grant ${RUN}`);
  await page.close();
});

test("a role that still grants a deprecated permission shows 'migration needed'", async () => {
  const dbUrl = process.env.E2E_CORE_DATABASE_URL;
  test.skip(!dbUrl, "E2E_CORE_DATABASE_URL isn't set");
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    // An app upgrade that dropped the permission would do this: it's deprecated, not deleted, while a role still grants it.
    await db.query("UPDATE permissions SET deprecated_at = now() WHERE key = 'notes.write'");
    const page = await adminCtx.newPage();
    await page.goto(`${ADMIN}/admin/roles?app=notes`);
    await expect(page.getByTestId("migration-notes.editor")).toContainText("Migration needed");
    await expect(page.getByTestId("migration-notes.editor")).toContainText("notes.write");
    await expect(page.getByTestId("migration-notes.viewer")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/a7-migration-needed.png` });
    await page.close();
  } finally {
    await db.query("UPDATE permissions SET deprecated_at = NULL WHERE key = 'notes.write'");
    await db.end();
  }
});

test("the admin deactivates notes: it disappears from the launcher", async () => {
  const page = await adminCtx.newPage();
  await openApps(page);
  // Cancel first: nothing changes.
  await page.getByRole("button", { name: "Deactivate Notes" }).click();
  await page.getByRole("dialog", { name: "Deactivate Notes?" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("state-notes")).toHaveText("active");

  await page.getByRole("button", { name: "Deactivate Notes" }).click();
  await page
    .getByRole("dialog", { name: "Deactivate Notes?" })
    .getByRole("button", { name: "Deactivate", exact: true })
    .click();
  await expect(page.getByTestId("flash-notice")).toContainText("notes is inactive");
  await expect(page.getByTestId("state-notes")).toHaveText("inactive");

  // Gone from the launcher (core-api's answer), and the app itself now says "unavailable" at once.
  await expect.poll(() => launcherFor("dev-member"), { timeout: 15_000 }).not.toContain("notes");
  const member = await memberCtx.newPage();
  const res = await member.goto(NOTES);
  expect(res?.status()).toBe(503);
  await expect(member.getByRole("heading", { name: /temporarily unavailable/i })).toBeVisible();
  await member.screenshot({ path: `${SHOTS}/a8-deactivated-unavailable.png` });
  await member.close();
  await page.close();
});

test("revoking asks first, then takes the role away", async () => {
  const page = await adminCtx.newPage();
  await page.goto(`${ADMIN}/admin/roles?app=notes`);
  await page.getByRole("button", { name: "Revoke notes.editor from dev-member" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke notes.editor?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByTestId("flash-notice")).toContainText("Revoked notes.editor from dev-member");
  await expect(page.getByTestId("holder-notes.editor-dev-member")).toHaveCount(0);
  await page.close();
});

test("every admin action is in the audit log under the admin's own name", async () => {
  const page = await adminCtx.newPage();
  await page.goto(`${ADMIN}/admin/audit`);
  await expect(page.getByRole("heading", { level: 2, name: "Audit" })).toBeVisible();

  // The UI: filter by app and actor.
  await page.getByLabel("App").selectOption("notes");
  await page.getByLabel("Actor contains").fill("dev-admin");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  const actors = await page.getByTestId("audit-actor").allTextContents();
  expect(actors.every((a) => a === "user:dev-admin")).toBe(true);
  const actions = await page.getByTestId("audit-action").allTextContents();
  for (const wanted of ["app.activated", "role.granted", "app.deactivated", "role.revoked"])
    expect(actions).toContain(wanted);
  await page.screenshot({ path: `${SHOTS}/a9-audit.png` });

  // And the log itself (core-api), exactly: since this run began, these four, in order, all by user:dev-admin.
  const log = (await (
    await fetch(`${CORE_API}/admin/v1/audit?limit=200`, { headers: { authorization: `Bearer ${TOKEN}` } })
  ).json()) as {
    events: { id: number; actor: string; action: string; appId: string | null }[];
  };
  const mine = log.events.filter((e) => e.id > startId && e.actor === "user:dev-admin").reverse();
  expect(mine.map((e) => `${e.action}:${e.appId}`)).toEqual([
    "app.activated:notes",
    "role.granted:notes", // the granted-twice request wrote nothing: a repeat grant changes nothing
    "app.deactivated:notes",
    "role.revoked:notes",
  ]);
  await page.close();
});

test("the console works from the keyboard and has labels, landmarks and captions", async () => {
  const page = await adminCtx.newPage();
  await openApps(page);

  // Skip link is the first stop and moves focus to the content.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  // Landmarks, one h1, a captioned table with column headers.
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator("table caption").first()).toBeVisible();
  await expect(page.locator("table th[scope=col]").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Apps" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // A dialog opened by keyboard: focus moves into it (Cancel first), Escape closes it, focus returns to the button.
  const trigger = page.getByRole("button", { name: "Activate Notes" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Activate Notes?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Every form control has an accessible name, on every page that has any.
  for (const path of ["/admin/apps", "/admin/roles?app=notes", "/admin/audit"]) {
    await page.goto(`${ADMIN}${path}`);
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea, button"))
        .filter((el) => {
          const e = el as HTMLInputElement;
          const text = (e.textContent ?? "").trim();
          return (
            !(e.labels && e.labels.length) &&
            !e.getAttribute("aria-label") &&
            !e.getAttribute("aria-labelledby") &&
            !text &&
            !e.title
          );
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unnamed, `${path}: controls without an accessible name`).toEqual([]);
  }
  await page.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme} theme: text, buttons, badges and links keep a contrast of at least 4.5:1`, async () => {
    const page = await adminCtx.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    const checked: Record<string, number> = {};
    for (const path of ["/admin/apps", "/admin/roles?app=notes", "/admin/audit"]) {
      await page.goto(`${ADMIN}${path}`);
      const ratios = await page.evaluate(() => {
        const parse = (c: string) => (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? "0,0,0").split(",").map((n) => parseFloat(n));
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
        };
        /** The background actually behind an element: the nearest ancestor that isn't transparent. */
        const backdrop = (el: Element): number[] => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor);
            if ((c[3] ?? 1) > 0.5) return c;
          }
          return parse(getComputedStyle(document.documentElement).backgroundColor);
        };
        const ratio = (el: Element) => {
          const a = lum(parse(getComputedStyle(el).color));
          const b = lum(backdrop(el));
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const out: Record<string, number> = {};
        const sample: Record<string, string> = {
          body: "main p, main h2",
          muted: ".muted",
          primary: "button:not(.secondary):not(.danger)",
          secondary: "button.secondary:not(.danger)",
          danger: "button.secondary.danger, button.danger",
          nav: 'nav[aria-label="Admin"] a[aria-current="page"]',
          th: "th[scope=col]",
          badge: ".badge",
          link: "main a",
        };
        for (const [name, selector] of Object.entries(sample)) {
          const el = document.querySelector(selector);
          if (el) out[name] = Math.round(ratio(el) * 100) / 100;
        }
        return out;
      });
      for (const [name, r] of Object.entries(ratios)) checked[`${path} ${name}`] = r;
    }
    const failing = Object.entries(checked).filter(([, r]) => r < 4.5);
    expect(failing, `${scheme}: ${JSON.stringify(checked)}`).toEqual([]);
    expect(Object.keys(checked).length).toBeGreaterThan(10); // it really sampled things
    const lowest = Object.entries(checked).sort((a, b) => a[1] - b[1])[0]!;
    console.log(`${scheme}: ${Object.keys(checked).length} samples, lowest contrast ${lowest[1]}:1 (${lowest[0]})`);
    await page.goto(`${ADMIN}/admin/apps`);
    await page.screenshot({ path: `${SHOTS}/b-${scheme}-apps.png` });
    await page.close();
  });
}
