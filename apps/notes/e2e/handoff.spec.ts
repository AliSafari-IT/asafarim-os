/**
 * Hub → identity assertion hand-off, in Chromium (asafarim-os#40).
 *
 * Hub's assertion page carries `form-action <issuer>`, and Chromium applies that to EVERY redirect in a
 * form-submission chain. So if identity answered the assertion POST with a 303 to the client's origin,
 * the browser would block it. Identity must answer 200 with a page that navigates instead.
 *
 * Nothing here is mocked on the identity side: a fake Hub page (served by Playwright) sends Hub's exact
 * CSP and auto-POSTs a valid assertion to the real `/interaction/<uid>/hub`. Requires E2E_ISSUER and
 * E2E_HUB_ASSERTION_PRIVATE_JWK (pnpm e2e provides both); skipped otherwise.
 */
import { createServer } from "node:http";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { expect, test } from "@playwright/test";

const ISSUER = process.env.E2E_ISSUER;
const PRIVATE_JWK = process.env.E2E_HUB_ASSERTION_PRIVATE_JWK;
const CLIENT_ID = "dev-app";
const CALLBACK = "http://localhost:4199/callback";
const FAKE_HUB = "http://localhost:4000/oidc/continue";
const SUBJECT = "dev-admin";

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

function assertionFor(uid: string): string {
  const key = createPrivateKey({ key: JSON.parse(PRIVATE_JWK!), format: "jwk" });
  const iat = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const body = b64(
    JSON.stringify({ iss: "hub", aud: "id", sub: SUBJECT, uid, jti: b64(randomBytes(16)), iat, exp: iat + 60 }),
  );
  return `${head}.${body}.${b64(sign(null, Buffer.from(`${head}.${body}`), key))}`;
}

// Same shape as apps/hub's assertionPage: the script is allowed by hash, and the only permitted form target is the issuer.
const SUBMIT_SCRIPT = 'document.getElementById("handoff").submit();';
const scriptHash = `'sha256-${createHash("sha256").update(SUBMIT_SCRIPT).digest("base64")}'`;
const hubCsp = (issuer: string) =>
  `default-src 'none'; script-src ${scriptHash}; style-src 'unsafe-inline'; form-action ${new URL(issuer).origin}; base-uri 'none'; frame-ancestors 'none'`;

function hubPage(target: string, assertion: string) {
  return `<!doctype html><meta charset="utf-8"><title>Signing in</title>
<form id="handoff" method="post" action="${target}"><input type="hidden" name="assertion" value="${assertion}"></form>
<script>${SUBMIT_SCRIPT}</script>`;
}

test.describe("Hub assertion hand-off (#40)", () => {
  test.skip(!ISSUER || !PRIVATE_JWK, "needs E2E_ISSUER and E2E_HUB_ASSERTION_PRIVATE_JWK (run pnpm e2e)");

  test("the browser follows identity's answer to the client's callback with a code", async ({ page }) => {
    const issuer = ISSUER!;
    // The test client's callback: a real listener, so the browser's final navigation has somewhere to land.
    const callback = createServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<title>cb</title>"),
    );
    await new Promise<void>((ok) => callback.listen(Number(new URL(CALLBACK).port), "127.0.0.1", ok));
    try {
      const verifier = b64(randomBytes(32));
      const auth = new URL(`${issuer}/auth`);
      for (const [k, v] of Object.entries({
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        response_type: "code",
        scope: "openid email profile roles",
        state: "st-40",
        nonce: "nn-40",
        code_challenge: b64(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      }))
        auth.searchParams.set(k, v);

      // Start the sign-in the way a client's browser would, but read identity's two redirects instead of following
      // them: Playwright doesn't route a redirect's target, and the browser must land on the fake Hub page below.
      // The request context shares the browser's cookies, so the interaction cookie ends up where the POST needs it.
      const start = await page.request.get(auth.href, { maxRedirects: 0 });
      const interaction = new URL(start.headers()["location"]!, issuer);
      const toHub = await page.request.get(interaction.href, { maxRedirects: 0 });
      const hubUrl = new URL(toHub.headers()["location"]!);
      expect(hubUrl.origin + hubUrl.pathname).toBe(FAKE_HUB);

      await page.route(FAKE_HUB + "**", async (route) => {
        // Identity's ticket is a signed JWS whose payload names the interaction (uid): all Hub needs from it.
        const ticket = new URL(route.request().url()).searchParams.get("ticket")!;
        const { uid } = JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()) as { uid: string };
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: { "content-security-policy": hubCsp(issuer) },
          body: hubPage(`${issuer}/interaction/${uid}/hub`, assertionFor(uid)),
        });
      });

      // The fake Hub auto-POSTs the assertion to the real identity; identity's answer must get the browser home.
      await page.goto(hubUrl.href, { waitUntil: "commit" });
      await page.waitForURL(/localhost:4199\/callback\?/);
      const back = new URL(page.url());
      expect(back.searchParams.get("code")).toBeTruthy();
      expect(back.searchParams.get("state")).toBe("st-40");
    } finally {
      await new Promise((ok) => callback.close(ok));
    }
  });

  test("canary: Hub's CSP does block a form POST that is redirected to another origin", async ({ page }) => {
    // Proves the first test exercises the real constraint: if Chromium stopped enforcing it, that test would
    // pass for the wrong reason (and so would a 303).
    const issuer = ISSUER!;
    const blocked: string[] = [];
    page.on("console", (m) => /form-action|Content Security Policy/i.test(m.text()) && blocked.push(m.text()));
    await page.route("http://localhost:4000/canary", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "content-security-policy": hubCsp(issuer) },
        body: hubPage(`${issuer}/canary-redirect`, "x"),
      }),
    );
    await page.route(`${issuer}/canary-redirect`, (route) =>
      route.fulfill({ status: 303, headers: { location: CALLBACK } }),
    );
    await page.route(
      (u) => u.href.startsWith(CALLBACK),
      (route) => route.fulfill({ status: 200, body: "reached" }),
    );
    await page.goto("http://localhost:4000/canary", { waitUntil: "commit" });
    await expect.poll(() => blocked.length).toBeGreaterThan(0);
    expect(page.url()).not.toContain("4199");
  });
});
