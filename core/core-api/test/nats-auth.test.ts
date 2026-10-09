import { generateKeyPairSync } from "node:crypto";
import { signNatsConnect } from "@asafarim/registry-protocol";
import { createAccount, createUser, fromPublic } from "@nats-io/nkeys";
import { describe, expect, it } from "vitest";
import { ed25519Scheme } from "../src/credentials.ts";
import {
  allowOnly,
  answerAuthRequest,
  checkConnect,
  decodeNatsJwtPayload,
  encodeNatsJwt,
  generateIssuer,
  natsPermissions,
} from "../src/nats-auth.ts";

const manifestWith = (publishes: string[], subscribes: string[]) => ({
  events: {
    publishes: publishes.map((type) => ({ type })),
    subscribes: subscribes.map((type) => ({ type })),
  },
});

describe("natsPermissions (manifest → what the credential may do)", () => {
  it("publisher only: its own namespace, replies on the inbox, nothing else", () => {
    expect(natsPermissions("notes", manifestWith(["notes.note.created.v1"], []))).toEqual({
      publish: ["notes.>"],
      subscribe: ["_INBOX.>"],
    });
  });

  it("subscriber only: its own durables on the publisher's stream, the pull, the acks and its dead letters", () => {
    expect(natsPermissions("recorder", manifestWith([], ["notes.note.created.v1"]))).toEqual({
      publish: [
        "$JS.ACK.APP_NOTES.recorder_notes_note_created_v1.>",
        "$JS.API.CONSUMER.INFO.APP_NOTES.recorder_notes_note_created_v1",
        "$JS.API.CONSUMER.MSG.NEXT.APP_NOTES.recorder_notes_note_created_v1",
        "deadletter.recorder.>",
      ],
      subscribe: ["_INBOX.>"],
    });
  });

  it("both: the union, one durable per subscribed type", () => {
    const p = natsPermissions(
      "hub",
      manifestWith(["hub.thing.made.v1"], ["notes.note.created.v1", "tasks.task.done.v2"]),
    );
    expect(p.publish).toContain("hub.>");
    expect(p.publish).toContain("deadletter.hub.>");
    expect(p.publish.filter((s) => s.startsWith("$JS.API.CONSUMER.MSG.NEXT."))).toEqual([
      "$JS.API.CONSUMER.MSG.NEXT.APP_NOTES.hub_notes_note_created_v1",
      "$JS.API.CONSUMER.MSG.NEXT.APP_TASKS.hub_tasks_task_done_v2",
    ]);
    expect(p.subscribe).toEqual(["_INBOX.>"]);
  });

  it("no events (or no manifest): publishes nothing, only the inbox", () => {
    expect(natsPermissions("quiet", {})).toEqual({ publish: [], subscribe: ["_INBOX.>"] });
    expect(natsPermissions("quiet", null)).toEqual({ publish: [], subscribe: ["_INBOX.>"] });
  });

  it("namespaces can't leak: notes never gets notesx.>, and no wildcard reaches another app", () => {
    const p = natsPermissions("notes", manifestWith(["notes.note.created.v1"], ["tasks.task.done.v1"]));
    expect(p.publish).toContain("notes.>");
    expect(p.publish).not.toContain("notesx.>");
    expect(p.publish).not.toContain(">");
    // "notes.>" matches notes.x, never notesx.x: NATS tokens are split on dots.
    for (const s of [...p.publish, ...p.subscribe]) {
      expect(s).not.toBe("*");
      expect(s).not.toMatch(/^\$JS\.API\.(STREAM|CONSUMER\.(CREATE|DELETE|DURABLE))/);
      expect(s).not.toMatch(/\$JS\.API\.CONSUMER\.\w+\.>$/);
    }
  });

  it("never lets an app touch another app's durable, even one with a prefix of its id", () => {
    const p = natsPermissions("note", manifestWith([], ["notes.note.created.v1"]));
    expect(p.publish.join("\n")).toContain("note_notes_note_created_v1");
    expect(p.publish.join("\n")).not.toContain("notes_notes");
  });

  it("is deterministic (sorted, no duplicates), so a re-connect is the same grant", () => {
    const a = natsPermissions("xx", manifestWith(["xx.a.b.v1"], ["yy.c.d.v1", "yy.c.d.v1", "zz.e.f.v1"]));
    const b = natsPermissions("xx", manifestWith(["xx.a.b.v1"], ["zz.e.f.v1", "yy.c.d.v1"]));
    expect(a).toEqual(b);
    expect(new Set(a.publish).size).toBe(a.publish.length);
  });
});

describe("allowOnly: an empty allow list would mean 'no restriction' to NATS", () => {
  it("writes an empty list as deny-everything", () => {
    expect(allowOnly([])).toEqual({ allow: [], deny: [">"] });
    expect(allowOnly(["a.>"])).toEqual({ allow: ["a.>"], deny: [] });
  });
});

// --- the connect assertion ---------------------------------------------------------------

function credentialFor(appId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = `${appId}.0123456789ab`;
  return {
    keyId,
    verifier: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    secret: `osk1.${keyId}.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`,
  };
}

/** A pool double over the three queries checkConnect makes. */
function fakePool(opts: {
  apps?: Record<string, { state: string; manifest: object | null }>;
  keys?: { keyId: string; appId: string; verifier: string; revoked?: boolean }[];
}) {
  const nonces = new Set<string>();
  return {
    nonces,
    async query(text: string, values: unknown[] = []) {
      if (text.startsWith("SELECT state, manifest FROM apps")) {
        const row = opts.apps?.[values[0] as string];
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.startsWith("SELECT scheme, verifier FROM app_credentials")) {
        const k = opts.keys?.find((x) => x.keyId === values[0] && x.appId === values[1] && !x.revoked);
        return { rows: k ? [{ scheme: "ed25519-v1", verifier: k.verifier }] : [], rowCount: k ? 1 : 0 };
      }
      if (text.startsWith("INSERT INTO registry_nonces")) {
        const fresh = !nonces.has(values[0] as string);
        nonces.add(values[0] as string);
        return { rows: [], rowCount: fresh ? 1 : 0 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("checkConnect (the assertion an app sends as its NATS password)", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const cred = credentialFor("notes");
  const pool = () =>
    fakePool({
      apps: { notes: { state: "active", manifest: manifestWith(["notes.note.created.v1"], []) } },
      keys: [{ keyId: cred.keyId, appId: "notes", verifier: cred.verifier }],
    });
  const deps = (p = pool()) => ({ pool: p as never, scheme: ed25519Scheme, now: () => now });
  const sign = (over: Partial<Parameters<typeof signNatsConnect>[0]> = {}) =>
    signNatsConnect({ appId: "notes", credential: cred.secret, now, ...over });

  it("accepts a valid assertion and returns the app's current manifest", async () => {
    const r = await checkConnect(deps(), "notes", sign());
    expect(r).toMatchObject({ ok: true, appId: "notes" });
    expect(r.ok && r.manifest).toEqual(manifestWith(["notes.note.created.v1"], []));
  });

  it("refuses an assertion signed for another app (wrong app)", async () => {
    const r = await checkConnect(deps(), "tasks", sign());
    expect(r).toEqual({ ok: false, reason: "malformed" });
    // And a key id of another app presented under this user name is no better.
    const other = credentialFor("tasks");
    const forged = signNatsConnect({ appId: "tasks", credential: other.secret, now });
    expect(await checkConnect(deps(), "notes", forged)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a signature that doesn't verify with the app's key", async () => {
    const stranger = { ...credentialFor("notes"), keyId: cred.keyId };
    const wrong = signNatsConnect({
      appId: "notes",
      credential: stranger.secret.replace(stranger.keyId, cred.keyId),
      now,
    });
    expect(await checkConnect(deps(), "notes", wrong)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a revoked key", async () => {
    const p = fakePool({
      apps: { notes: { state: "active", manifest: null } },
      keys: [{ keyId: cred.keyId, appId: "notes", verifier: cred.verifier, revoked: true }],
    });
    expect(await checkConnect(deps(p), "notes", sign())).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("refuses a removed or unknown app", async () => {
    const removed = fakePool({
      apps: { notes: { state: "removed", manifest: null } },
      keys: [{ keyId: cred.keyId, appId: "notes", verifier: cred.verifier }],
    });
    expect(await checkConnect(deps(removed), "notes", sign())).toEqual({ ok: false, reason: "unknown_app" });
    expect(await checkConnect(deps(fakePool({})), "notes", sign())).toEqual({ ok: false, reason: "unknown_app" });
  });

  it("refuses a stale (or future) timestamp, beyond ±60 s", async () => {
    const late = sign({ now: new Date(now.getTime() - 61_000) });
    const early = sign({ now: new Date(now.getTime() + 61_000) });
    expect(await checkConnect(deps(), "notes", late)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(await checkConnect(deps(), "notes", early)).toEqual({ ok: false, reason: "stale_timestamp" });
    const edge = sign({ now: new Date(now.getTime() - 59_000) });
    expect((await checkConnect(deps(), "notes", edge)).ok).toBe(true);
  });

  it("refuses a replayed nonce, and a stale one doesn't burn the nonce", async () => {
    const p = pool();
    const pass = sign();
    expect((await checkConnect(deps(p), "notes", pass)).ok).toBe(true);
    expect(await checkConnect(deps(p), "notes", pass)).toEqual({ ok: false, reason: "replayed_nonce" });

    const stale = sign({ now: new Date(now.getTime() - 120_000), nonce: "s".repeat(24) });
    await checkConnect(deps(p), "notes", stale);
    expect(p.nonces.has("s".repeat(24))).toBe(false);
  });

  it("refuses missing and malformed credentials without touching the database", async () => {
    const p = { query: () => Promise.reject(new Error("must not be called")) };
    const d = { pool: p as never, now: () => now };
    expect(await checkConnect(d, undefined, undefined)).toEqual({ ok: false, reason: "no_credentials" });
    expect(await checkConnect(d, "notes", "")).toEqual({ ok: false, reason: "no_credentials" });
    expect(await checkConnect(d, "notes", "garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(await checkConnect(d, "Not An Id", sign())).toEqual({ ok: false, reason: "malformed" });
  });
});

// --- the NATS JWTs -----------------------------------------------------------------------

describe("answerAuthRequest (the whole callout, minus the socket)", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const issuer = generateIssuer();
  const cred = credentialFor("notes");
  const pool = fakePool({
    apps: { notes: { state: "active", manifest: manifestWith(["notes.note.created.v1"], []) } },
    keys: [{ keyId: cred.keyId, appId: "notes", verifier: cred.verifier }],
  });
  const server = createAccount(); // stands in for the NATS server's own key
  const request = (user?: string, pass?: string) => {
    const u = createUser();
    return {
      userNkey: u.getPublicKey(),
      jwt: encodeNatsJwt(
        {
          iat: 1,
          iss: server.getPublicKey(),
          sub: "UAAAA",
          aud: "nats-authorization-request",
          nats: {
            user_nkey: u.getPublicKey(),
            server_id: { name: "n", id: "NSERVERID" },
            connect_opts: { user, pass },
            type: "authorization_request",
            version: 2,
          },
        },
        server,
      ),
    };
  };
  const deps = { pool: pool as never, issuerSeed: issuer.seed, account: "OS", now: () => now };

  it("grants a verified app a user JWT signed by the issuer with exactly its permissions", async () => {
    const req = request("notes", signNatsConnect({ appId: "notes", credential: cred.secret, now }));
    const out = await answerAuthRequest(deps, req.jwt);
    const response = decodeNatsJwtPayload<{
      iss: string;
      sub: string;
      aud: string;
      nats: { jwt?: string; error?: string };
    }>(out!);
    expect(response).toMatchObject({ iss: issuer.publicKey, sub: req.userNkey, aud: "NSERVERID" });
    expect(response.nats.error).toBeUndefined();

    const user = decodeNatsJwtPayload<{
      iss: string;
      sub: string;
      aud: string;
      name: string;
      nats: { pub: { allow: string[]; deny: string[] }; sub: { allow: string[] } };
    }>(response.nats.jwt!);
    expect(user).toMatchObject({ iss: issuer.publicKey, sub: req.userNkey, aud: "OS", name: "notes" });
    expect(user.nats.pub.allow).toEqual(["notes.>"]);
    expect(user.nats.sub.allow).toEqual(["_INBOX.>"]);

    // The JWT is really signed by the issuer key.
    const [h, p, s] = out!.split(".") as [string, string, string];
    expect(fromPublic(issuer.publicKey).verify(Buffer.from(`${h}.${p}`), Buffer.from(s, "base64url"))).toBe(true);
  });

  it("answers a refusal with an error and no user JWT", async () => {
    const lines: { msg: string; reason?: string }[] = [];
    const out = await answerAuthRequest({ ...deps, log: (l) => lines.push(l) }, request("notes", "garbage").jwt);
    const response = decodeNatsJwtPayload<{ nats: { jwt?: string; error?: string } }>(out!);
    expect(response.nats.jwt).toBeUndefined();
    expect(response.nats.error).toBeTruthy();
    expect(lines).toContainEqual({ msg: "bus.auth.refused", reason: "malformed", app: "notes" });
  });

  it("refuses an anonymous connect", async () => {
    const out = await answerAuthRequest(deps, request().jwt);
    expect(decodeNatsJwtPayload<{ nats: { jwt?: string } }>(out!).nats.jwt).toBeUndefined();
  });

  it("refuses (does not crash) when the registry database is down", async () => {
    const down = { query: () => Promise.reject(new Error("connection refused")) };
    const req = request("notes", signNatsConnect({ appId: "notes", credential: cred.secret, now }));
    const out = await answerAuthRequest({ ...deps, pool: down as never }, req.jwt);
    expect(decodeNatsJwtPayload<{ nats: { jwt?: string; error?: string } }>(out!).nats).toMatchObject({
      error: "registry unavailable",
    });
  });

  it("refuses (does not crash) when the stored manifest has a malformed event type", async () => {
    const bad = fakePool({
      apps: { notes: { state: "active", manifest: manifestWith([], ["Not A Type"]) } },
      keys: [{ keyId: cred.keyId, appId: "notes", verifier: cred.verifier }],
    });
    const req = request("notes", signNatsConnect({ appId: "notes", credential: cred.secret, now }));
    const out = await answerAuthRequest({ ...deps, pool: bad as never }, req.jwt);
    expect(decodeNatsJwtPayload<{ nats: { jwt?: string; error?: string } }>(out!).nats.jwt).toBeUndefined();
  });

  it("ignores a request it can't read", async () => {
    expect(await answerAuthRequest(deps, "not a jwt")).toBeUndefined();
  });
});
