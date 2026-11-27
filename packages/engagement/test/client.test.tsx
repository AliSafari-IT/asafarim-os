// @vitest-environment jsdom
/**
 * The React components and the browser client, against a fake fetch (no server): optimistic likes and their
 * rollback, the guest's sign-in prompt, posting, replying and the inline delete confirmation.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommentSection,
  compactCount,
  createEngagementClient,
  EngagementApiError,
  EngagementBadge,
  insertComment,
  LikeButton,
  likedHint,
  removeComment,
  replaceComment,
  type ClientComment,
  type ClientThread,
} from "../src/client/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (method: string, url: URL, body: unknown) => { status?: number; body: unknown; headers?: HeadersInit };

function fakeFetch(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://app.test");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const r = handler(method, url, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const comment = (over: Partial<ClientComment> = {}): ClientComment => ({
  id: over.id ?? "c1",
  entityType: "lesson",
  entityId: "l1",
  userId: "u1",
  author: { name: "Alice", avatarUrl: null, role: null },
  parentId: null,
  body: "Hello",
  isPinned: false,
  status: "visible",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  ...over,
});
const thread = (over: Partial<ClientThread> = {}): ClientThread => ({ ...comment(over), replies: over.replies ?? [] });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: HTMLElement | null) =>
  act(async () => {
    el!.click();
  });
function type(el: HTMLElement | null, value: string) {
  const area = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("helpers", () => {
  it("compacts counts", () => {
    expect([0, 7, 999, 1000, 1250, 12_345, 2_000_000, -3].map(compactCount)).toEqual([
      "0",
      "7",
      "999",
      "1k",
      "1.2k",
      "12.3k",
      "2M",
      "0",
    ]);
  });

  it("inserts, replaces and removes comments in a thread list", () => {
    let list = [thread({ id: "a" })];
    list = insertComment(list, comment({ id: "b" }));
    list = insertComment(list, comment({ id: "r", parentId: "a" }));
    expect(list.map((t) => [t.id, t.replies.map((r) => r.id)])).toEqual([
      ["a", ["r"]],
      ["b", []],
    ]);
    list = replaceComment(list, comment({ id: "r", parentId: "a", body: "edited" }));
    expect(list[0]!.replies[0]!.body).toBe("edited");
    expect(removeComment(list, "r").removed).toBe(1);
    expect(removeComment(list, "a")).toMatchObject({ removed: 2, threads: [{ id: "b" }] });
    expect(removeComment(list, "zzz").removed).toBe(0);
  });

  it("maps an error answer to EngagementApiError with Retry-After", async () => {
    const { fn } = fakeFetch(() => ({
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down" } },
      headers: { "retry-after": "12" },
    }));
    const err = await createEngagementClient({ fetch: fn })
      .toggleLike({ entityType: "lesson", entityId: "l1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngagementApiError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 12 });
  });

  it("survives a localStorage that throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    try {
      expect(likedHint.read({ entityType: "lesson", entityId: "l1" })).toBeNull();
      expect(() => likedHint.write({ entityType: "lesson", entityId: "l1" }, true)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("EngagementBadge", () => {
  it("renders the counts with words for screen readers, and nothing when both are zero", () => {
    const html = renderToStaticMarkup(<EngagementBadge likes={1240} comments={1} />);
    expect(html).toContain("♥ 1.2k");
    expect(html).toContain("💬 1");
    expect(html).toContain('aria-label="1240 likes, 1 comment"');
    expect(renderToStaticMarkup(<EngagementBadge likes={0} comments={0} />)).toBe("");
    expect(renderToStaticMarkup(<EngagementBadge likes={0} comments={0} hideWhenEmpty={false} />)).toContain("♥ 0");
  });
});

describe("LikeButton", () => {
  it("loads the state, toggles optimistically and takes the server's answer", async () => {
    let liked = false;
    let count = 4;
    const { fn, calls } = fakeFetch((method) => {
      if (method === "POST") {
        liked = !liked;
        count += liked ? 1 : -1;
      }
      return { body: { liked, count } };
    });
    act(() =>
      root.render(
        <LikeButton
          entityType="lesson"
          entityId="l1"
          initialCount={3}
          client={createEngagementClient({ fetch: fn })}
        />,
      ),
    );
    expect(q("like-count")!.textContent).toBe("3");
    await flush();
    expect(q("like-count")!.textContent).toBe("4");
    await click(q("like-button"));
    await flush();
    expect(q("like-button")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("like-count")!.textContent).toBe("5");
    expect(likedHint.read({ entityType: "lesson", entityId: "l1" })).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/engagement/likes?entityType=lesson&entityId=l1",
      "POST /api/engagement/likes/toggle",
    ]);
    expect(calls[1]!.body).toEqual({ entityType: "lesson", entityId: "l1" });
  });

  it("rolls back and explains a rate limit", async () => {
    const { fn } = fakeFetch((method) =>
      method === "POST"
        ? { status: 429, body: { error: { code: "rate_limited", message: "x" } }, headers: { "retry-after": "30" } }
        : { body: { liked: false, count: 2 } },
    );
    act(() =>
      root.render(<LikeButton entityType="lesson" entityId="l1" client={createEngagementClient({ fetch: fn })} />),
    );
    await flush();
    await click(q("like-button"));
    await flush();
    expect(q("like-button")!.getAttribute("aria-pressed")).toBe("false");
    expect(q("like-count")!.textContent).toBe("2");
    expect(host.textContent).toContain("Try again in 30 s");
  });
});

describe("CommentSection", () => {
  const list = [
    thread({
      id: "p",
      isPinned: true,
      body: "Pinned note",
      author: { name: "Teacher", avatarUrl: null, role: "instructor" },
    }),
    thread({ id: "a", body: "First", replies: [comment({ id: "r1", parentId: "a", body: "A reply", userId: "u2" })] }),
  ];

  it("shows a guest the comments, pinned first, and a sign-in link instead of a form", async () => {
    const { fn } = fakeFetch(() => ({ body: { comments: list, total: 2 } }));
    act(() =>
      root.render(
        <CommentSection
          entityType="lesson"
          entityId="l1"
          viewer={null}
          signInHref="/signin?next=/x"
          client={createEngagementClient({ fetch: fn })}
        />,
      ),
    );
    await flush();
    expect(qa("comment-body").map((e) => e.textContent)).toEqual(["Pinned note", "First", "A reply"]);
    expect(q("comment-role")!.textContent).toBe("Instructor");
    expect(q("comment-form")).toBeNull();
    expect(q("comment-sign-in")!.querySelector("a")!.getAttribute("href")).toBe("/signin?next=/x");
    expect(q("comments-heading")!.textContent).toContain("(3)");
    expect(qa("comment-delete")).toHaveLength(0);
  });

  it("tells a signed-in reader without the permission that they can only read", async () => {
    const { fn } = fakeFetch(() => ({ body: { comments: [], total: 0 } }));
    act(() =>
      root.render(
        <CommentSection
          entityType="lesson"
          entityId="l1"
          viewer={{ id: "u9", canComment: false }}
          client={createEngagementClient({ fetch: fn })}
        />,
      ),
    );
    await flush();
    expect(q("comment-form")).toBeNull();
    expect(q("comment-no-permission")).not.toBeNull();
    expect(q("comments-empty")).not.toBeNull();
  });

  it("posts a comment and a reply, and deletes only after the inline confirmation", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch((method, url, body) => {
      if (method === "GET") return { body: { comments: [thread({ id: "a", userId: "me", body: "Mine" })], total: 1 } };
      if (method === "POST") {
        const b = body as { body: string; parentId: string | null };
        return {
          status: 201,
          body: { comment: comment({ id: `new${++n}`, userId: "me", body: b.body, parentId: b.parentId }) },
        };
      }
      if (method === "DELETE") return { body: { removed: url.pathname.endsWith("/a") ? 2 : 1 } };
      return { status: 500, body: {} };
    });
    act(() =>
      root.render(
        <CommentSection
          entityType="lesson"
          entityId="l1"
          viewer={{ id: "me", canComment: true }}
          client={createEngagementClient({ fetch: fn })}
        />,
      ),
    );
    await flush();
    type(q("comment-input"), "  Great lesson  ");
    await act(async () => {
      q("comment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      entityType: "lesson",
      entityId: "l1",
      body: "Great lesson",
      parentId: null,
    });
    expect(qa("comment-body").map((e) => e.textContent)).toEqual(["Mine", "Great lesson"]);

    await click(qa("comment-reply")[0]!);
    const forms = qa("comment-form");
    type(forms[1]!.querySelector("textarea"), "Thanks");
    await act(async () => {
      forms[1]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls.filter((c) => c.method === "POST")[1]!.body).toMatchObject({ parentId: "a", body: "Thanks" });
    expect(qa("comment-body").map((e) => e.textContent)).toEqual(["Mine", "Thanks", "Great lesson"]);
    expect(q("comments-heading")!.textContent).toContain("(3)");

    await click(qa("comment-delete")[0]!);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await click(q("comment-delete-confirm"));
    await flush();
    expect(calls.find((c) => c.method === "DELETE")!.path).toBe("/api/engagement/comments/a");
    expect(qa("comment-body").map((e) => e.textContent)).toEqual(["Great lesson"]);
    expect(q("comments-heading")!.textContent).toContain("(1)");
  });
});
