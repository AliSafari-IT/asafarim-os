import { asafarimAuthConfig } from "@asafarim/app-sdk";
import { describe, expect, it } from "vitest";
import robots from "../app/robots";
import nextConfig from "../next.config";

describe("never indexed (#79)", () => {
  it("every response carries X-Robots-Tag: noindex, nofollow", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
    expect(all).not.toHaveProperty("has");
    expect(all).not.toHaveProperty("missing");
  });

  it("robots.txt disallows everything", () => {
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("401 and 403 pages are on (unauthorized() and forbidden())", () => {
    expect(nextConfig.experimental?.authInterrupts).toBe(true);
  });
});

describe("the session cookie (#79)", () => {
  it("is host-only: __Host-, HttpOnly, Secure, SameSite=Lax, no Domain", () => {
    const config = asafarimAuthConfig({ issuer: "http://id.test", clientId: "docs", secret: "s" });
    const cookie = config.cookies?.sessionToken;
    expect(cookie?.name).toMatch(/^__Host-/);
    expect(cookie?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(cookie?.options).not.toHaveProperty("domain");
  });
});
