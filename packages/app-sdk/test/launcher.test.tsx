import { generateKeyPairSync, verify } from "node:crypto";
import { canonicalString } from "@asafarim/registry-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccessUnavailableError, createAccess, parseLauncher, type LauncherTile } from "../src/index.ts";
import { LAUNCHER_CSS, Launcher, safeHref } from "../src/react.tsx";

const tile = (key: string, over: Partial<LauncherTile> = {}): LauncherTile => ({
  key,
  name: key.toUpperCase(),
  description: `${key} app`,
  glyph: key.slice(0, 2).toUpperCase(),
  meta: `${key}.example`,
  status: "active",
  access: "authenticated",
  order: 10,
  href: `http://${key}.localhost:8080`,
  ...over,
});

function cred() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "notes.0123456789ab";
  return {
    secret: `osk1.${keyId}.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`,
    publicKey,
  };
}

describe("access.launcher", () => {
  function setup(answer: () => Response, now = { t: 1_000_000 }) {
    const c = cred();
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return answer();
    }) as unknown as typeof fetch;
    const access = createAccess({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core/",
      fetch: fetchFn,
      now: () => now.t,
      tokens: { verify: async () => undefined },
    });
    return { c, calls, access, now };
  }
  const ok = (apps: unknown) => () => new Response(JSON.stringify({ subject: "x", apps }), { status: 200 });

  it("asks core-api with a signed GET bound to the person's launcher path", async () => {
    const { c, calls, access } = setup(ok([tile("notes")]));
    expect((await access.launcher("user@example.test")).map((t) => t.key)).toEqual(["notes"]);
    const path = "/registry/v1/apps/notes/launcher/user%40example.test";
    expect(calls[0]!.url).toBe(`http://core${path}`);
    const h = new Headers(calls[0]!.init?.headers);
    const sig = /^v1=(.+)$/.exec(h.get("x-asafarim-signature")!)![1]!;
    const msg = canonicalString(h.get("x-asafarim-timestamp")!, h.get("x-asafarim-nonce")!, "GET", path, "");
    expect(verify(null, Buffer.from(msg), c.publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("caches for the TTL (one call for concurrent and repeated asks), then asks again", async () => {
    const { calls, access, now } = setup(ok([tile("notes")]));
    await Promise.all([access.launcher("a"), access.launcher("a")]);
    await access.launcher("a");
    expect(calls).toHaveLength(1);
    await access.launcher("b"); // another person: another answer
    expect(calls).toHaveLength(2);
    now.t += 60_001;
    await access.launcher("a");
    expect(calls).toHaveLength(3);
  });

  it("fails closed: an outage, a refusal and a malformed answer throw, and none is cached", async () => {
    let answer: () => Response = () => new Response(JSON.stringify({ error: "app_inactive" }), { status: 503 });
    const { access } = setup(() => answer());
    await expect(access.launcher("a")).rejects.toThrow(AccessUnavailableError);
    answer = () => new Response(JSON.stringify({ apps: [{ key: "x" }] }), { status: 200 }); // not the contract
    await expect(access.launcher("a")).rejects.toThrow(/malformed/);
    answer = ok([tile("notes")]);
    expect(await access.launcher("a")).toHaveLength(1); // the failures weren't remembered
  });

  it("parseLauncher accepts the contract and nothing else", () => {
    expect(parseLauncher({ apps: [tile("a")] })).toHaveLength(1);
    expect(parseLauncher({ apps: [] })).toEqual([]);
    for (const bad of [
      null,
      {},
      { apps: "x" },
      { apps: [null] },
      { apps: [{ ...tile("a"), href: "" }] },
      { apps: [{ ...tile("a"), order: "1" }] },
    ]) {
      expect(parseLauncher(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("<Launcher>", () => {
  it("renders a labelled navigation landmark with a link per app, glyph hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<Launcher apps={[tile("notes"), tile("docs")]} />);
    expect(html).toContain('<nav class="asafarim-launcher" aria-label="Apps">');
    expect(html).toContain('<a href="http://notes.localhost:8080/" title="notes app">');
    expect(html).toContain('<span class="asafarim-launcher__glyph" aria-hidden="true">NO</span><span>NOTES</span>');
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("marks the current app, and only that one", () => {
    const html = renderToStaticMarkup(<Launcher apps={[tile("notes"), tile("docs")]} current="notes" />);
    // anchors only: the inline CSS also mentions [aria-current="page"]
    const current = html.match(/<a [^>]*aria-current="page"[^>]*>/g) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain("notes.localhost");
  });

  it("takes a custom landmark name", () => {
    expect(renderToStaticMarkup(<Launcher apps={[tile("notes")]} label="ASafariM apps" />)).toContain(
      'aria-label="ASafariM apps"',
    );
  });

  it("renders nothing for no apps", () => {
    expect(renderToStaticMarkup(<Launcher apps={[]} />)).toBe("");
  });

  it("escapes text, and refuses non-http(s) links", () => {
    const html = renderToStaticMarkup(
      <Launcher
        apps={[
          tile("evil", { name: '<img src=x onerror="alert(1)">', description: '"><script>x</script>' }),
          tile("js", { href: "javascript:alert(1)" }),
          tile("data", { href: "data:text/html,<script>1</script>" }),
          tile("nope", { href: "not a url" }),
        ]}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html.match(/<li>/g)).toHaveLength(1); // only the one with a safe link
  });

  it("safeHref allows http and https only", () => {
    expect(safeHref("https://notes.asafarim.site")).toBe("https://notes.asafarim.site/");
    expect(safeHref("http://notes.localhost:8080/x")).toBe("http://notes.localhost:8080/x");
    for (const bad of ["javascript:1", "//evil.example", "/relative", "ftp://x", ""])
      expect(safeHref(bad), bad).toBeUndefined();
  });

  it("is keyboard- and theme-ready: a visible focus style and a dark scheme, using the host's tokens", () => {
    expect(LAUNCHER_CSS).toContain(":focus-visible");
    expect(LAUNCHER_CSS).toContain("prefers-color-scheme:dark");
    expect(LAUNCHER_CSS).toContain("var(--card,");
  });
});
