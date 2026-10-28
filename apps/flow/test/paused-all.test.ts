/**
 * The kill switch in the engine: while Settings `paused_all` is on, a trigger starts no run (on any
 * workflow), the refusal is logged and audited; once it is off, the next trigger starts one as usual.
 */
import { ulid } from "@asafarim/app-sdk/events";
import { describe, expect, it } from "vitest";
import { createEngine, type InboundEvent } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import { DOCS_NOTE_TO_ISSUE } from "../lib/workflow/seed";
import { memoryDb } from "./memory-store";

const note = (): InboundEvent => ({
  id: ulid(),
  type: "docs.note.created.v1",
  data: {
    id: "42",
    author: "dev-admin",
    docPath: "guides/getting-started.md",
    tags: ["issue"],
    hasIssue: false,
    createdAt: "2026-10-26T10:00:00.000Z",
  },
});

describe("Pause all", () => {
  it("no new run starts while it is on; it is logged and audited; off again, runs start", async () => {
    const mem = memoryDb();
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      info: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
      warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
    };
    const engine = createEngine({
      store: () => mem.store,
      publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
      newId: () => ulid(),
      log,
    });
    mem.publish(DOCS_NOTE_TO_ISSUE.definition);

    mem.settings.pausedAll = true;
    const event = note();
    expect(await engine.handle(mem.tx, event)).toEqual([
      { action: "flow.run.refused", triggerEventId: event.id, errorCode: "paused_all" },
    ]);
    expect(mem.runs.size).toBe(0);
    expect(mem.outbox).toEqual([]);
    expect(logs).toContainEqual({
      msg: "flow.trigger.paused_all",
      fields: { eventId: event.id, type: "docs.note.created.v1" },
    });

    mem.settings.pausedAll = false;
    await engine.handle(mem.tx, note());
    expect(mem.runs.size).toBe(1);
  });
});
