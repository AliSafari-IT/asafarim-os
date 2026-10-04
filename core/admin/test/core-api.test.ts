import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreApiError, coreApi } from "../lib/core-api";

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const lastCall = (fn: ReturnType<typeof stub>) => {
  const [url, init] = fn.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, init };
};

describe("the console's core-api client", () => {
  it("sends the administrator's identity token as the bearer, never cached", async () => {
    process.env.CORE_API_URL = "http://core.test/";
    const fn = stub(200, { apps: [] });
    await coreApi("id.token.jwt").apps();
    const { url, init } = lastCall(fn);
    expect(url).toBe("http://core.test/admin/v1/apps");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer id.token.jwt");
    expect(init.cache).toBe("no-store");
  });

  it("builds the admin calls: methods, encoded ids, filters", async () => {
    process.env.CORE_API_URL = "http://core.test";
    let fn = stub(200, { state: "active" });
    await coreApi("t").activate("notes");
    expect(lastCall(fn)).toMatchObject({
      url: "http://core.test/admin/v1/apps/notes/activate",
      init: { method: "POST" },
    });
    await coreApi("t").deactivate("notes");
    expect(lastCall(fn).url).toBe("http://core.test/admin/v1/apps/notes/deactivate");

    fn = stub(200, { granted: true });
    await coreApi("t").grant("notes.editor", "user@example.test:1");
    expect(lastCall(fn)).toMatchObject({
      url: "http://core.test/admin/v1/roles/notes.editor/grants/user%40example.test%3A1",
      init: { method: "PUT" },
    });
    fn = stub(200, { revoked: true });
    await coreApi("t").revoke("notes.editor", "dev-member");
    expect(lastCall(fn).init.method).toBe("DELETE");

    fn = stub(200, { events: [], next: null });
    await coreApi("t").audit({ app: "notes", actor: "dev admin", before: 40, limit: 25 });
    expect(lastCall(fn).url).toBe("http://core.test/admin/v1/audit?app=notes&actor=dev+admin&before=40&limit=25");
    await coreApi("t").audit();
    expect(lastCall(fn).url).toBe("http://core.test/admin/v1/audit?");

    fn = stub(200, { roles: [] });
    await coreApi("t").roles("notes");
    expect(lastCall(fn).url).toBe("http://core.test/admin/v1/roles?app=notes");
    await coreApi("t").roles();
    expect(lastCall(fn).url).toBe("http://core.test/admin/v1/roles");
  });

  it("turns a refusal into a CoreApiError that carries core-api's status, code and message", async () => {
    stub(403, { error: "forbidden", message: "needs the role core.admin" });
    const err = await coreApi("t")
      .session()
      .catch((e) => e);
    expect(err).toBeInstanceOf(CoreApiError);
    expect(err).toMatchObject({ status: 403, code: "forbidden", message: "needs the role core.admin" });
  });

  it("an unreachable core-api is status 0, with a message that doesn't leak the cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:4020"))),
    );
    const err = await coreApi("t")
      .apps()
      .catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
    expect(String(err.message)).not.toContain("10.0.0.5");
  });
});
