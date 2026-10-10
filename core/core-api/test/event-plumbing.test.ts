import { describe, expect, it } from "vitest";
import {
  consumerOutcome,
  planEventPlumbing,
  planRemoval,
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
      orphaned: [],
    });
  });

  it("a subscriber: one consumer per subscribed type, deduplicated and sorted; no stream", () => {
    const plan = planEventPlumbing({ appId: "tasks", manifest: m([], [NOTE_DELETED, NOTE, NOTE]), installed: [] });
    expect(plan).toEqual({ stream: false, own: [NOTE, NOTE_DELETED], remove: [], dependents: [], orphaned: [] });
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
      orphaned: [],
    });
  });

  it("an app that subscribes to its own type: its own consumer, not a dependent of itself", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE], [NOTE]),
      installed: [{ id: "notes", manifest: m([NOTE], [NOTE]) }],
    });
    expect(plan).toEqual({ stream: true, own: [NOTE], remove: [], dependents: [], orphaned: [] });
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
      orphaned: [],
    });
  });

  it("install (no previous manifest) removes nothing", () => {
    expect(
      planEventPlumbing({ appId: "tasks", manifest: m([], [NOTE]), previous: null, installed: [] }).remove,
    ).toEqual([]);
  });
});

describe("planEventPlumbing: an upgrade that stops publishing a type (orphaned consumers)", () => {
  const notesBefore = m([NOTE, NOTE_DELETED]);

  it("drops nothing: no orphaned consumers, whoever subscribes", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE, NOTE_DELETED]),
      previous: notesBefore,
      installed: [{ id: "tasks", manifest: m([], [NOTE, NOTE_DELETED]) }],
    });
    expect(plan.orphaned).toEqual([]);
    expect(plan.dependents).toEqual([
      { app: "tasks", type: NOTE },
      { app: "tasks", type: NOTE_DELETED },
    ]);
  });

  it("drops one type: the subscribers of that type only; the kept type stays a dependent", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE]),
      previous: notesBefore,
      installed: [
        { id: "tasks", manifest: m([], [NOTE, NOTE_DELETED]) },
        { id: "other", manifest: m([], [TASK]) },
      ],
    });
    expect(plan.orphaned).toEqual([{ app: "tasks", type: NOTE_DELETED }]);
    expect(plan.dependents).toEqual([{ app: "tasks", type: NOTE }]);
  });

  it("several subscribers and several dropped types: sorted by app, then type; apps without events skipped", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: {},
      previous: notesBefore,
      installed: [
        { id: "tasks", manifest: m([TASK], [NOTE_DELETED, NOTE]) },
        { id: "audit", manifest: m([], [NOTE]) },
        { id: "empty", manifest: null },
      ],
    });
    expect(plan).toEqual({
      stream: false,
      own: [],
      remove: [],
      dependents: [],
      orphaned: [
        { app: "audit", type: NOTE },
        { app: "tasks", type: NOTE },
        { app: "tasks", type: NOTE_DELETED },
      ],
    });
  });

  it("the publisher subscribing to its own dropped type is not an orphan of itself", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE], [NOTE_DELETED]),
      previous: m([NOTE, NOTE_DELETED], [NOTE_DELETED]),
      installed: [{ id: "notes", manifest: m([NOTE, NOTE_DELETED], [NOTE_DELETED]) }],
    });
    expect(plan.orphaned).toEqual([]);
  });

  it("only the installed apps it is given count: removed apps (filtered out by the registry) get nothing", () => {
    // The registry passes only apps whose state isn't `removed` (lockAndReadInstalled).
    expect(planEventPlumbing({ appId: "notes", manifest: {}, previous: notesBefore, installed: [] }).orphaned).toEqual(
      [],
    );
  });

  it("install (no previous manifest) orphans nothing", () => {
    expect(
      planEventPlumbing({
        appId: "notes",
        manifest: m([NOTE]),
        previous: null,
        installed: [{ id: "tasks", manifest: m([], [NOTE_DELETED]) }],
      }).orphaned,
    ).toEqual([]);
  });

  it("a later upgrade that re-adds the type makes its subscribers dependents again (their consumer is re-created)", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: notesBefore,
      previous: m([NOTE]),
      installed: [{ id: "tasks", manifest: m([], [NOTE_DELETED]) }],
    });
    expect(plan.orphaned).toEqual([]);
    expect(plan.dependents).toEqual([{ app: "tasks", type: NOTE_DELETED }]);
  });

  it("once the publisher stops declaring the type, its subscribers wait for a publisher again", () => {
    const sub = m([], [NOTE_DELETED]);
    const installed = [
      { id: "tasks", manifest: sub },
      { id: "notes", manifest: m([NOTE]) },
    ];
    expect(waitingForPublisher("tasks", sub, installed)).toEqual([NOTE_DELETED]);
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

describe("planEventPlumbing: a self-subscribing publisher that stops publishing its type (#63 follow-up)", () => {
  it("the type goes to remove, not own, and waits for a publisher", () => {
    const plan = planEventPlumbing({
      appId: "notes",
      manifest: m([NOTE_DELETED], [NOTE, NOTE_DELETED]),
      previous: m([NOTE, NOTE_DELETED], [NOTE, NOTE_DELETED]),
      installed: [],
    });
    expect(plan).toMatchObject({ stream: true, own: [NOTE_DELETED], remove: [NOTE] });
    expect(waitingForPublisher("notes", m([NOTE_DELETED], [NOTE, NOTE_DELETED]), [])).toEqual([NOTE]);
  });

  it("stable across repeated registrations: remove again (an idempotent delete), never back in own", () => {
    const now = m([], [NOTE, TASK]);
    for (let i = 0; i < 3; i++) {
      expect(planEventPlumbing({ appId: "notes", manifest: now, previous: now, installed: [] })).toMatchObject({
        own: [TASK],
        remove: [NOTE],
      });
    }
  });

  it("at install too: an own-namespace type it doesn't publish gets no consumer", () => {
    expect(planEventPlumbing({ appId: "notes", manifest: m([], [NOTE]), installed: [] })).toMatchObject({
      stream: false,
      own: [],
      remove: [NOTE],
    });
  });

  it("another app's type with the same prefix but another namespace is not affected", () => {
    const type = "notesx.thing.created.v1";
    expect(planEventPlumbing({ appId: "notes", manifest: m([], [type]), installed: [] })).toMatchObject({
      own: [type],
      remove: [],
    });
  });
});

describe("planRemoval: what removing an app does on the bus (pure)", () => {
  const installed = [
    { id: "tasks", manifest: m([TASK], [NOTE, NOTE_DELETED]) },
    { id: "audit", manifest: m([], [NOTE, TASK]) },
    { id: "empty", manifest: null },
  ];

  it("a publisher: the other apps' consumers of anything in its namespace, and its stream", () => {
    expect(planRemoval({ appId: "notes", manifest: m([NOTE]), installed })).toEqual({
      own: [],
      dependents: [
        { app: "audit", type: NOTE },
        { app: "tasks", type: NOTE },
        { app: "tasks", type: NOTE_DELETED }, // not declared any more, but on its stream
      ],
      stream: true,
    });
  });

  it("a subscriber: its own consumers; nobody else's", () => {
    expect(planRemoval({ appId: "audit", manifest: m([], [TASK, NOTE, NOTE]), installed })).toEqual({
      own: [NOTE, TASK],
      dependents: [],
      stream: true,
    });
  });

  it("both: its own consumers and its subscribers'", () => {
    expect(planRemoval({ appId: "tasks", manifest: m([TASK], [NOTE]), installed })).toEqual({
      own: [NOTE],
      dependents: [{ app: "audit", type: TASK }],
      stream: true,
    });
  });

  it("a self-subscriber: its own consumer once, never a dependent of itself", () => {
    expect(
      planRemoval({
        appId: "notes",
        manifest: m([NOTE], [NOTE]),
        installed: [{ id: "notes", manifest: m([NOTE], [NOTE]) }],
      }),
    ).toEqual({ own: [NOTE], dependents: [], stream: true });
  });

  it("an app without events or manifest: only the (idempotent) stream delete", () => {
    expect(planRemoval({ appId: "quiet", manifest: null, installed })).toEqual({
      own: [],
      dependents: [],
      stream: true,
    });
  });
});
