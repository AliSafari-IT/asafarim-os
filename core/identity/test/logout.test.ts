import type { Provider } from "oidc-provider";
import { describe, expect, it, vi } from "vitest";
import { notifySessionLogout } from "../src/logout.ts";

describe("local identity logout notifications", () => {
  it("notifies each registered RP with its own sid and the authenticated subject", async () => {
    const one = vi.fn().mockResolvedValue(undefined);
    const two = vi.fn().mockResolvedValue(undefined);
    const clients = new Map([
      [
        "one",
        {
          backchannelLogoutUri: "https://one.test/logout",
          backchannelLogoutSessionRequired: true,
          backchannelLogout: one,
        },
      ],
      [
        "two",
        {
          backchannelLogoutUri: "https://two.test/logout",
          backchannelLogoutSessionRequired: true,
          backchannelLogout: two,
        },
      ],
    ]);
    const provider = { Client: { find: vi.fn(async (id: string) => clients.get(id)) } } as unknown as Provider;
    await notifySessionLogout(provider, {
      accountId: "subject",
      authorizations: { one: { sid: "sid-one" }, two: { sid: "sid-two" }, removed: {} },
    });
    expect(one).toHaveBeenCalledExactlyOnceWith("subject", "sid-one");
    expect(two).toHaveBeenCalledExactlyOnceWith("subject", "sid-two");
  });

  it("skips missing registration or required sid without preventing other notifications", async () => {
    const send = vi.fn();
    const provider = {
      Client: {
        find: vi.fn(async (id: string) =>
          id === "missing"
            ? undefined
            : {
                backchannelLogoutUri: "https://rp.test/logout",
                backchannelLogoutSessionRequired: true,
                backchannelLogout: send,
              },
        ),
      },
    } as unknown as Provider;
    await notifySessionLogout(provider, {
      accountId: "subject",
      authorizations: { missing: { sid: "sid" }, noSid: {} },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("failed client lookup/delivery is logged without throwing or skipping successful RPs", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const provider = {
      Client: {
        find: vi.fn(async (id: string) => {
          if (id === "lookup") throw new Error("private details");
          return {
            backchannelLogoutUri: "https://rp.test/logout",
            backchannelLogoutSessionRequired: true,
            backchannelLogout: id === "failed" ? vi.fn().mockRejectedValue(new Error("private details")) : send,
          };
        }),
      },
    } as unknown as Provider;
    await expect(
      notifySessionLogout(
        provider,
        {
          accountId: "subject",
          authorizations: { lookup: { sid: "one" }, failed: { sid: "two" }, success: { sid: "three" } },
        },
        { warn },
      ),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith("subject", "three");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private details");
  });
});
