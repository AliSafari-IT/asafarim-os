import { describe, expect, it } from "vitest";
import { busConnectOptions } from "../src/bus-auth.ts";

describe("busConnectOptions", () => {
  it("keeps reconnecting through auth callout outages", () => {
    const o = busConnectOptions({ user: "notes", pass: () => "p" });
    expect(o.ignoreAuthErrorAbort).toBe(true);
    expect("inboxPrefix" in o).toBe(false);
  });

  it("adds the inbox prefix when set", () => {
    expect(busConnectOptions({ user: "notes", pass: () => "p", inboxPrefix: "_INBOX_notes" }).inboxPrefix).toBe(
      "_INBOX_notes",
    );
  });
});
