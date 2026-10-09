import { describe, expect, it } from "vitest";
import {
  consumerOutcome,
  planEventPlumbing,
  publishedTypes,
  subscribedTypes,
  waitingForPublisher,
  type EventsManifest,
} from "../src/event-plumbing.ts";

const m = (publishes: string[] = [], subscribes: string[] = []): EventsManifest => ({
  events: {
    publishes: publishes.map((type) => ({ type })),
    subscribes: subscribes.map((type) => ({ type })),
  },
});

const NOTE = "notes.note.created.v1";
const NOTE_DELETED = "notes.note.deleted.v1";
const TASK = "tasks.task.created.v1";

describe("planEventPlumbing: which consumers an install or an upgrade adds and removes (pure)", () => {
  it("an app without events: nothing to do", () => {
    expect(planEventPlumbing({ appId: "quiet", manifest: {}, installed: [] })).toEqual({
      stream: false,
      own: [],
      remove: [],
      dependents: [],
    });
  });

  it("a subscriber: one consumer per subscribed type, deduplicated and sorted; no stream", () => {
    const plan = planEventPlumbing({ appId: "tasks", manifest: m([], [NOTE_DELETED, NOTE, NOTE]), installed: [] });
    expect(plan).toEqual({ stream: false, own: [NOTE, NOTE_DELETED], remove: [], dependents: [] });
  });

  it("a publisher installed after its subscribers: their consumers, only for the types it declares", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE]),
      installed: [
        { id: "tasks", manifest: m([TASK], [NOTE, NOTE_DELETED]) }, // NOTE_DELETED: not declared (yet)
        { id: "audit", manifest: m([], [NOTE]) },
        { id: "other", manifest: m([], [TASK]) }, // another publisher's type
        { id: "empty", manifest: null },
      ],
    });
    expect(plan).toEqual({
      stream: true,
      own: [],
      remove: [],
      dependents: [
        { app: "audit", type: NOTE },
        { app: "tasks", type: NOTE },
      ],
    });
  });

  it("an app that subscribes to its own type: its own consumer, not a dependent of itself", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE], [NOTE]),
      installed: [{ id: "notes", manifest: m([NOTE], [NOTE]) }],
    });
    expect(plan).toEqual({ stream: true, own: [NOTE], remove: [], dependents: [] });
  });

  it("an upgrade that drops a subscription removes only that consumer; one that keeps all removes none", () => {
    expect(
      planEventPlumbing({
        appId: "tasks",
        manifest: m([], [NOTE]),
        previous: m([], [NOTE, NOTE_DELETED]),
        installed: [],
      }),
    ).toMatchObject({ own: [NOTE], remove: [NOTE_DELETED] });
    expect(
      planEventPlumbing({ appId: "tasks", manifest: m([], [NOTE]), previous: m([], [NOTE]), installed: [] }).remove,
    ).toEqual([]);
    expect(planEventPlumbing({ appId: "tasks", manifest: {}, previous: m([], [NOTE]), installed: [] })).toEqual({
      stream: false,
      own: [],
      remove: [NOTE],
      dependents: [],
    });
  });

  it("install (no previous manifest) removes nothing", () => {
    expect(
      planEventPlumbing({ appId: "tasks", manifest: m([], [NOTE]), previous: null, installed: [] }).remove,
    ).toEqual([]);
  });
});

describe("waitingForPublisher: subscriptions whose publisher isn't installed", () => {
  it("a type no installed app declares is waiting; one that an installed app (or the app itself) declares isn't", () => {
    const installed = [
      { id: "notes", manifest: m([NOTE]) },
      { id: "tasks", manifest: m([TASK], [NOTE, NOTE_DELETED, "tasks.task.done.v1"]) },
    ];
    expect(waitingForPublisher("tasks", installed[1]!.manifest, installed)).toEqual([
      NOTE_DELETED,
      "tasks.task.done.v1",
    ]);
    expect(waitingForPublisher("tasks", m([TASK, "tasks.task.done.v1"], ["tasks.task.done.v1"]), installed)).toEqual(
      [],
    );
  });

  it("an app installed before its publisher waits; once the publisher is installed it doesn't", () => {
    const sub = m([], [NOTE]);
    expect(waitingForPublisher("tasks", sub, [{ id: "tasks", manifest: sub }])).toEqual([NOTE]);
    expect(
      waitingForPublisher("tasks", sub, [
        { id: "tasks", manifest: sub },
        { id: "notes", manifest: m([NOTE]) },
      ]),
    ).toEqual([]);
  });

  it("no events, or a null manifest: nothing waits", () => {
    expect(waitingForPublisher("x", null, [])).toEqual([]);
    expect(waitingForPublisher("x", {}, [])).toEqual([]);
  });
});

describe("helpers", () => {
  it("published/subscribed types: unique and sorted, empty without events", () => {
    expect(publishedTypes(m([TASK, NOTE, NOTE]))).toEqual([NOTE, TASK]);
    expect(subscribedTypes(undefined)).toEqual([]);
    expect(subscribedTypes({ events: {} })).toEqual([]);
  });

  it("the bus's no_stream is reported as waiting_for_publisher; other results pass through", () => {
    expect(consumerOutcome("no_stream")).toBe("waiting_for_publisher");
    for (const r of ["created", "updated", "exists"]) expect(consumerOutcome(r)).toBe(r);
  });
});
