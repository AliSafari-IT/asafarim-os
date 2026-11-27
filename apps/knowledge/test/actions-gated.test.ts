import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The gateway checks studio PAGES only (#363); studio POSTs reach the app and are authorised there.
 * So every server action in app/studio/actions.ts, course-actions.ts and media-actions.ts must start at the studio gate.
 */
describe("studio server actions", () => {
  it("each one passes the studio gate before doing anything", () => {
    const src = ["actions.ts", "course-actions.ts", "media-actions.ts"]
      .map((f) => readFileSync(path.resolve(import.meta.dirname, "../app/studio", f), "utf8"))
      .join("\n");
    const actions = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
    expect(actions.map((a) => a[1]).sort()).toEqual(
      [
        "autosaveAction",
        "changeSlugAction",
        "classifyAction",
        "createArticleAction",
        "createCourseAction",
        "editCourseAction",
        "publishCourseAction",
        "withdrawCourseAction",
        "createTagAction",
        "createTopicAction",
        "deleteArticleAction",
        "discardAutosaveAction",
        "publishAction",
        "saveDraftAction",
        "withdrawAction",
        "requestUploadAction",
        "finishUploadAction",
        "listMediaAction",
        "deleteMediaAction",
      ].sort(),
    );
    for (const [, name, body] of actions) {
      expect(body, name).toMatch(/await (?:studioGate|actorOrRedirect)\(/);
    }
  });
});
