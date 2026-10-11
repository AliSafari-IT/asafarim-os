/**
 * Study notes (#81), end to end on the real stack and the app's real database, as dev-member holding
 * docs.owner:
 *
 *   select text in the roadmap → "Add note" → it shows in the Notes list (Markdown rendered) and as a
 *   highlight → edit it → a note on a heading (pointing at it) → delete that one → a note whose quoted
 *   text isn't in the document shows under its heading as "text changed" → /notes lists them, by
 *   document → Lighthouse accessibility ≥ 95, light and dark, with notes on the page.
 *
 * `pnpm e2e` then restarts the Docs server and runs the `@after-restart` test: the notes are still
 * there. Screenshots go to test-results/screens/, Lighthouse to test-results/lighthouse-notes.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { accessibilityScore, grantOwner, MIN_A11Y, revokeOwner, ROADMAP, roadmapUrl, SHOTS, signIn } from "./support";

const NOTE = "Ask **Team B** when the beta ships.";
const EDITED = "Asked: the beta ships *next week*.";
const GONE_QUOTE = "a sentence that was edited away";

/** Remove every note dev-member has, so a run starts (and the restart run ends) clean. */
async function removeAllNotes(request: APIRequestContext) {
  const res = await request.get("/api/notes");
  expect(res.status()).toBe(200);
  for (const n of ((await res.json()) as { notes: { id: string }[] }).notes) {
    expect((await request.delete(`/api/notes/${n.id}`)).status()).toBe(204);
  }
}

const notes = (page: Page) => page.getByTestId("notes").getByTestId("note");

test.describe.configure({ mode: "serial" });

test.describe("before a restart", () => {
  test.beforeAll(grantOwner);
  // The notes stay for the @after-restart run; only the role goes.
  test.afterAll(revokeOwner);

  test("create, edit and delete notes on a document; text edited away shows as changed", async ({ page }) => {
    await signIn(page);
    await removeAllNotes(page.request);
    await page.goto(roadmapUrl());
    const body = page.getByTestId("doc-body");
    await expect(page.getByTestId("notes")).toContainText("No notes on this document yet");

    // Select text: "Add note" (and the not-yet-available "Generate GitHub issue") appear by it.
    const item = body.getByRole("listitem").filter({ hasText: "Ship the beta" });
    await item.selectText();
    await item.dispatchEvent("mouseup");
    const tools = page.getByTestId("selection-tools");
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("button", { name: "Generate GitHub issue" })).toHaveAttribute("aria-disabled", "true");
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/docs-notes-select-light.png` });
    await tools.getByRole("button", { name: "Add note" }).click();

    const editor = page.getByRole("dialog", { name: "Add a note" });
    await expect(editor.locator("blockquote")).toHaveText("Ship the beta");
    await editor.getByLabel(/Note/).fill(NOTE);
    await editor.getByRole("button", { name: "Save note" }).click();
    await expect(editor).toBeHidden();

    await expect(notes(page)).toHaveCount(1);
    const first = notes(page).first();
    await expect(first).toHaveAttribute("data-status", "ok");
    await expect(first.locator(".note-where")).toHaveText("Milestones");
    await expect(first.locator("blockquote")).toContainText("Ship the beta");
    // The body is Markdown, rendered (sanitized) on the server.
    await expect(first.locator(".note-body strong")).toHaveText("Team B");
    // …and the quote is highlighted in the text.
    await expect(body).toHaveAttribute("data-highlights", "1");
    expect(
      await page.evaluate(() => (CSS.highlights as unknown as Map<string, Set<Range>>).get("doc-notes")?.size),
    ).toBe(1);

    // Edit it.
    await first.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit note" });
    await edit.getByLabel(/Note/).fill(EDITED);
    await edit.getByRole("button", { name: "Save note" }).click();
    await expect(first.locator(".note-body em")).toHaveText("next week");

    // A note on a heading: point at it.
    await body.getByRole("heading", { name: "Setup" }).hover();
    const headingTools = page.getByTestId("heading-tools");
    await expect(headingTools).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/docs-notes-heading-light.png` });
    await headingTools.getByRole("button", { name: "Add note" }).click();
    const onHeading = page.getByRole("dialog", { name: "Add a note" });
    await expect(onHeading).toContainText("On Setup");
    await onHeading.getByLabel(/Note/).fill("Check the install steps.");
    await onHeading.getByRole("button", { name: "Save note" }).click();
    await expect(notes(page)).toHaveCount(2);
    await expect(notes(page).nth(1).locator(".note-where")).toHaveText("Setup");

    // Delete it: a styled dialog asks first.
    await notes(page).nth(1).getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete this note?" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(notes(page)).toHaveCount(1);

    // A note whose quote isn't in the document (as after an edit to it): kept, under its heading.
    const res = await page.request.post("/api/notes", {
      data: { docPath: ROADMAP, headingId: "timeline", quote: GONE_QUOTE, body: "This sentence was rewritten." },
    });
    expect(res.status()).toBe(201);
    await page.reload();
    await expect(notes(page)).toHaveCount(2);
    const changed = page.getByTestId("notes").locator('[data-status="changed"]');
    await expect(changed.locator(".note-where")).toContainText("Timeline");
    await expect(changed.getByTestId("text-changed")).toHaveText("text changed");
    await expect(changed.locator("blockquote")).toHaveText(GONE_QUOTE);
    // Only the quote that is in the text is highlighted.
    await expect(body).toHaveAttribute("data-highlights", "1");

    await page.getByTestId("notes").screenshot({ path: `${SHOTS}/docs-notes-light.png` });
    await item.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/docs-notes-highlight-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByTestId("notes").screenshot({ path: `${SHOTS}/docs-notes-dark.png` });
    await item.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/docs-notes-highlight-dark.png` });
  });

  test("/notes lists every note by document, filterable by document", async ({ page }) => {
    await signIn(page);
    await page.goto("/notes");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your notes");
    await expect(page.getByTestId("notes-doc")).toHaveCount(1);
    await expect(page.getByTestId("note")).toHaveCount(2);
    await expect(page.getByTestId("text-changed")).toHaveCount(1);
    await page.getByTestId("notes-filter").selectOption(ROADMAP);
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page).toHaveURL(/\/notes\?doc=/);
    await expect(page.getByTestId("note")).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/docs-notes-page.png`, fullPage: true });
  });

  test("Lighthouse accessibility is at least 95 with notes, light and dark", async () => {
    const results = [
      await accessibilityScore("light"),
      await accessibilityScore("dark"),
      await accessibilityScore("light", "/notes"),
      await accessibilityScore("dark", "/notes"),
    ];
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/lighthouse-notes.json", `${JSON.stringify(results, null, 2)}\n`);
    for (const r of results)
      console.log(
        `Lighthouse accessibility with notes (${r.url}, ${r.scheme}): ${Math.round(r.score * 100)}`,
        r.failing,
      );
    for (const r of results)
      expect(r.score, `${r.url} ${r.scheme}: ${r.failing.join("; ")}`).toBeGreaterThanOrEqual(MIN_A11Y);
  });
});

test.describe("after a restart", () => {
  test.beforeAll(grantOwner);
  test.afterAll(revokeOwner);

  test("@after-restart the notes are still there", async ({ page }) => {
    await signIn(page);
    await page.goto(roadmapUrl());
    await expect(notes(page)).toHaveCount(2);
    await expect(notes(page).first().locator(".note-body em")).toHaveText("next week");
    await expect(page.getByTestId("notes").getByTestId("text-changed")).toHaveCount(1);
    await expect(page.getByTestId("doc-body")).toHaveAttribute("data-highlights", "1");
    await removeAllNotes(page.request);
  });
});
