#!/usr/bin/env node
/**
 * `pnpm dev:smoke` (OS-D1, #26): the dev environment end to end, as CI runs it.
 *   compose up → bootstrap TWICE (idempotent) → core/identity + dev-hub →
 *   /readyz green → a full sign-in through the dev login stub → an ID token for
 *   a seeded user (and an inactive one refused) → stop. `--down` also removes
 *   the dev volumes afterwards (CI). Prints the steps without any token values.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { bootstrap } from "./bootstrap.mjs";
import { bold, compose, dbEnv, green, red, requireDocker } from "./infra.mjs";
import { DEV, DEV_DIR, ISSUER, ROOT, ensureDevKeys } from "./keys.mjs";

const HUB = `http://localhost:${DEV.devHubPort}`;
const children = [];
const step = (s) => console.log(`${green("✔")} ${s}`);

function start(name, envFile, entry) {
  const child = spawn(process.execPath, [`--env-file=${path.join(DEV_DIR, envFile)}`, path.join(ROOT, entry)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  children.push(child);
}

async function waitFor(url, ok = (r) => r.status === 200, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (ok(r)) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

class Jar {
  cookies = new Map();
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const value = pair.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function get(url, jar) {
  const res = await fetch(url, { redirect: "manual", headers: jar ? { cookie: jar.header() } : {} });
  jar?.take(res);
  return res;
}

const field = (html, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];

/** One browser signing in as `sub` through the dev stub. Returns the token response or the refusal. */
async function signIn(sub) {
  const jar = new Jar();
  const verifier = randomBytes(32).toString("base64url");
  const auth = new URL(`${ISSUER}/auth`);
  for (const [k, v] of Object.entries({
    client_id: "dev-app",
    redirect_uri: DEV.devClientCallback,
    response_type: "code",
    scope: "openid email profile roles",
    state: "smoke",
    nonce: randomBytes(8).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }))
    auth.searchParams.set(k, v);

  let res = await get(auth.href, jar);
  const interaction = new URL(res.headers.get("location"), ISSUER);
  res = await get(interaction.href, jar);
  const continueUrl = res.headers.get("location");
  if (!continueUrl?.startsWith(`${HUB}/oidc/continue?ticket=`))
    throw new Error(`expected a hand-off to the dev hub, got ${res.status}`);

  // The dev hub: list → pick `sub` → auto-POST page.
  const list = await (await get(continueUrl)).text();
  const ticket = field(list, "ticket");
  res = await fetch(`${HUB}/oidc/continue/select`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket, sub }),
  });
  const page = await res.text();
  const action = /<form id="handoff" method="post" action="([^"]+)">/.exec(page)?.[1];
  const assertion = field(page, "assertion");

  // The auto-POST (cross-site: no identity cookies sent), then the browser follows.
  res = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ assertion }),
  });
  jar.take(res);
  if (res.status !== 303) return { refused: res.status, body: await res.text() };
  let location = new URL(res.headers.get("location"), ISSUER).href;
  for (let i = 0; i < 6 && !location.startsWith(DEV.devClientCallback); i++) {
    res = await get(location, jar);
    location = new URL(res.headers.get("location"), ISSUER).href;
  }
  const code = new URL(location).searchParams.get("code");
  const tokens = await (
    await fetch(`${ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: DEV.devClientCallback,
        client_id: "dev-app",
        code_verifier: verifier,
      }),
    })
  ).json();
  return { tokens };
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

let failed = false;
try {
  requireDocker();
  ensureDevKeys();
  compose("up", "-d", "--wait");
  step("Postgres and Redis up (127.0.0.1 only)");
  await bootstrap(dbEnv());
  await bootstrap(dbEnv());
  step("bootstrap ran twice without errors (idempotent)");

  start("identity", "identity.env", "core/identity/src/server.ts");
  start("dev-hub", "dev-hub.env", "tools/dev-hub/src/server.ts");
  await waitFor(`${HUB}/healthz`);
  const ready = await (await waitFor(`${ISSUER}/readyz`)).json();
  step(`identity /readyz: ${JSON.stringify(ready)}`);
  const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  step(`discovery: issuer=${discovery.issuer}`);

  const member = await signIn("dev-member");
  if (!member.tokens?.id_token) throw new Error(`no ID token: ${JSON.stringify(member.tokens ?? member.refused)}`);
  const c = claims(member.tokens.id_token);
  step(`sign-in through the dev stub: ID token for sub=${c.sub}, aud=${c.aud}, iss=${c.iss} (token not printed)`);
  if (c.sub !== "dev-member") throw new Error(`unexpected sub ${c.sub}`);

  const inactive = await signIn("dev-inactive");
  if (inactive.refused !== 403 || !inactive.body.includes("account_inactive"))
    throw new Error("the inactive seeded user was not refused");
  step("the inactive seeded user is refused (403 account_inactive)");
  console.log(bold(green("\ndev smoke test: OK")));
} catch (err) {
  failed = true;
  console.error(red(`\ndev smoke test FAILED: ${err.message}`));
} finally {
  for (const c of children) c.kill();
  if (process.argv.includes("--down")) compose("down", "--volumes", "--remove-orphans");
}
process.exit(failed ? 1 : 0);
