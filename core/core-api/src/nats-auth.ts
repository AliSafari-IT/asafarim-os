/**
 * Per-app identities on the event bus (P4.1 PR 4, ADR 0001 §5): NATS auth callout served by core-api.
 *
 * The dev/CI NATS runs with an `auth_callout` block. Every connect that isn't core-api's own is sent
 * to `$SYS.REQ.USER.AUTH`; this module answers it:
 *
 *   app connects with  user = <appId>,  pass = v1.<keyId>.<ts>.<nonce>.<sig>   (registry-protocol)
 *   → checkConnect():  the app isn't removed, the key belongs to it and isn't revoked, the signature
 *                      verifies, the timestamp is within ±60 s, the nonce was never used
 *   → natsPermissions(): what ITS CURRENT manifest allows, nothing else
 *   → a user JWT signed with the callout issuer key
 *
 * Permissions come from the registry row at connect time, so an upgrade takes effect on the next
 * connect. Known limitation: a live connection keeps the permissions it was given until it
 * reconnects (revoking or rotating a key affects new connects only).
 */
import { createHash } from "node:crypto";
import { consumerName, publisherOf, streamName } from "@asafarim/events";
import { SIGNATURE_WINDOW_SECONDS, natsConnectCanonical, parseNatsConnect } from "@asafarim/registry-protocol";
import { connect } from "@nats-io/transport-node";
import { createAccount, fromSeed, type KeyPair } from "@nats-io/nkeys";
import type { NatsConnection } from "@nats-io/nats-core";
import type pg from "pg";
import { ed25519Scheme, type CredentialScheme } from "./credentials.ts";
import { publishedTypes, subscribedTypes, type EventsManifest } from "./event-plumbing.ts";

// ---------------------------------------------------------------------------------------------
// Permissions: a pure function of the app id and its manifest.
// ---------------------------------------------------------------------------------------------

export interface NatsPermissions {
  publish: string[];
  subscribe: string[];
}

/** Replies to pull requests and to JetStream publish acks arrive on the client's inbox. */
export const INBOX_SUBJECT = "_INBOX.>";

/**
 * What the app's NATS credential may do. Everything not listed is denied, notably
 * `$JS.API.STREAM.>` and consumer create/delete (core-api owns streams and consumers).
 *
 *  - publishes events (`events.publishes`): `<id>.>`, its own namespace (`notes` never gets `notesx.>`);
 *  - subscribes (`events.subscribes`): for each type, ONLY its own durable on the publisher's stream:
 *    consumer info, the pull request and the acks; and `deadletter.<id>.>` for the events it gives up on;
 *  - always: subscribe to `_INBOX.>` for replies. No raw subscribe on anyone's subjects.
 */
export function natsPermissions(appId: string, manifest: EventsManifest | null | undefined): NatsPermissions {
  const publish = new Set<string>();
  const subscribe = new Set<string>([INBOX_SUBJECT]);
  if (publishedTypes(manifest).length > 0) publish.add(`${appId}.>`);
  const types = subscribedTypes(manifest);
  if (types.length > 0) publish.add(`deadletter.${appId}.>`);
  for (const type of types) {
    const stream = streamName(publisherOf(type));
    const consumer = consumerName(appId, type);
    publish.add(`$JS.API.CONSUMER.INFO.${stream}.${consumer}`);
    publish.add(`$JS.API.CONSUMER.MSG.NEXT.${stream}.${consumer}`);
    publish.add(`$JS.ACK.${stream}.${consumer}.>`);
  }
  return { publish: [...publish].sort(), subscribe: [...subscribe].sort() };
}

// ---------------------------------------------------------------------------------------------
// The connect assertion.
// ---------------------------------------------------------------------------------------------

export type ConnectFailure =
  | "no_credentials"
  | "malformed"
  | "unknown_app"
  | "unknown_key"
  | "bad_signature"
  | "stale_timestamp"
  | "replayed_nonce";

export type ConnectCheck =
  { ok: true; appId: string; manifest: EventsManifest | null } | { ok: false; reason: ConnectFailure };

export interface ConnectDeps {
  pool: Pick<pg.Pool, "query">;
  scheme?: CredentialScheme;
  now?: () => Date;
}

/** Verify what an app sent as user + password. Never throws for a bad assertion; database errors do. */
export async function checkConnect(
  deps: ConnectDeps,
  user: string | undefined,
  pass: string | undefined,
): Promise<ConnectCheck> {
  const scheme = deps.scheme ?? ed25519Scheme;
  const now = deps.now ?? (() => new Date());
  if (!user || !pass) return { ok: false, reason: "no_credentials" };
  const a = parseNatsConnect(pass);
  if (!a || !/^[a-z][a-z0-9-]{1,31}$/.test(user) || !a.keyId.startsWith(`${user}.`)) {
    return { ok: false, reason: "malformed" };
  }
  const app = await deps.pool.query<{ state: string; manifest: EventsManifest | null }>(
    "SELECT state, manifest FROM apps WHERE id = $1",
    [user],
  );
  const row = app.rows[0];
  if (!row || row.state === "removed") return { ok: false, reason: "unknown_app" };
  const cred = await deps.pool.query<{ scheme: string; verifier: string }>(
    "SELECT scheme, verifier FROM app_credentials WHERE key_id = $1 AND app_id = $2 AND revoked_at IS NULL",
    [a.keyId, user],
  );
  const c = cred.rows[0];
  if (!c || c.scheme !== scheme.name) return { ok: false, reason: "unknown_key" };
  if (
    !scheme.verify(c.verifier, natsConnectCanonical(user, a.timestamp, a.nonce), Buffer.from(a.signature, "base64url"))
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  // Only a verified assertion reaches the clock and the replay cache, so a forged one can't burn a real nonce.
  const skew = Math.abs(now().getTime() / 1000 - Number(a.timestamp));
  if (skew > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: "stale_timestamp" };
  const fresh = await deps.pool.query(
    "INSERT INTO registry_nonces (nonce, app_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) ON CONFLICT DO NOTHING",
    [a.nonce, user, SIGNATURE_WINDOW_SECONDS * 2],
  );
  if (fresh.rowCount === 0) return { ok: false, reason: "replayed_nonce" };
  return { ok: true, appId: user, manifest: row.manifest };
}

// ---------------------------------------------------------------------------------------------
// NATS JWTs (ed25519-nkey), just what the callout needs.
// ---------------------------------------------------------------------------------------------

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Sign claims as a NATS JWT. `jti` is the base32 SHA-256 of the claims without it, like nats-io/jwt. */
export function encodeNatsJwt(claims: Record<string, unknown>, signer: KeyPair): string {
  const jti = base32(createHash("sha256").update(JSON.stringify(claims)).digest());
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" }));
  const body = b64url(JSON.stringify({ jti, ...claims }));
  const signature = b64url(signer.sign(Buffer.from(`${header}.${body}`)));
  return `${header}.${body}.${signature}`;
}

export function decodeNatsJwtPayload<T = Record<string, unknown>>(jwt: string): T {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as T;
}

/**
 * An allow-list as NATS reads it. An EMPTY allow list means "no restriction" to NATS, not "nothing",
 * so an empty one is written as deny-everything instead (a quiet app must not be able to publish).
 */
export const allowOnly = (allow: string[]) => (allow.length > 0 ? { allow, deny: [] } : { allow: [], deny: [">"] });

/** The user JWT the server accepts for this connection, with exactly the permissions given. */
export function buildUserJwt(opts: {
  issuer: KeyPair;
  userNkey: string;
  appId: string;
  account: string;
  permissions: NatsPermissions;
  now: Date;
}): string {
  return encodeNatsJwt(
    {
      iat: Math.floor(opts.now.getTime() / 1000),
      iss: opts.issuer.getPublicKey(),
      name: opts.appId,
      sub: opts.userNkey,
      aud: opts.account,
      nats: {
        pub: allowOnly(opts.permissions.publish),
        sub: allowOnly(opts.permissions.subscribe),
        subs: -1,
        data: -1,
        payload: -1,
        type: "user",
        version: 2,
      },
    },
    opts.issuer,
  );
}

/** The authorization response the server expects: the user JWT, or an error. */
export function buildAuthResponse(opts: {
  issuer: KeyPair;
  userNkey: string;
  serverId: string;
  now: Date;
  userJwt?: string;
  error?: string;
}): string {
  return encodeNatsJwt(
    {
      iat: Math.floor(opts.now.getTime() / 1000),
      iss: opts.issuer.getPublicKey(),
      sub: opts.userNkey,
      aud: opts.serverId,
      nats: {
        ...(opts.userJwt ? { jwt: opts.userJwt } : {}),
        ...(opts.error ? { error: opts.error } : {}),
        type: "authorization_response",
        version: 2,
      },
    },
    opts.issuer,
  );
}

interface AuthRequestClaims {
  nats?: {
    user_nkey?: string;
    server_id?: { id?: string };
    connect_opts?: { user?: string; pass?: string };
  };
}

export interface CalloutLog {
  (line: { msg: string; [k: string]: unknown }): void;
}

export interface CalloutDeps extends ConnectDeps {
  /** The callout issuer's nkey seed (an account key: SA…). Its public key is `auth_callout.issuer` in the NATS config. */
  issuerSeed: string;
  /** The NATS account the apps are put in (`auth_callout.account`), named as `aud` of the user JWT. */
  account: string;
  log?: CalloutLog;
}

/**
 * Answer one authorization request (the payload of a `$SYS.REQ.USER.AUTH` message) with the response
 * JWT to send back. Pure of NATS: the responder and the unit tests both call it.
 */
export async function answerAuthRequest(deps: CalloutDeps, requestJwt: string): Promise<string | undefined> {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());
  const issuer = fromSeed(new TextEncoder().encode(deps.issuerSeed));
  let claims: AuthRequestClaims;
  try {
    claims = decodeNatsJwtPayload<AuthRequestClaims>(requestJwt);
  } catch {
    log({ msg: "bus.auth.unreadable_request" });
    return undefined;
  }
  const userNkey = claims.nats?.user_nkey;
  const serverId = claims.nats?.server_id?.id;
  if (!userNkey || !serverId) {
    log({ msg: "bus.auth.unreadable_request" });
    return undefined;
  }
  const { user, pass } = claims.nats?.connect_opts ?? {};
  const refuse = (reason: string, error = "authorization violation") => {
    log({ msg: "bus.auth.refused", reason, app: user ?? null });
    return buildAuthResponse({ issuer, userNkey, serverId, now: now(), error });
  };
  let check: ConnectCheck;
  try {
    check = await checkConnect(deps, user, pass);
  } catch (err) {
    // The registry database is down: refuse (the app keeps its events in the outbox and retries).
    log({ msg: "bus.auth.registry_unavailable", error: (err as Error).message });
    return refuse("registry_unavailable", "registry unavailable");
  }
  if (!check.ok) return refuse(check.reason);
  let permissions: NatsPermissions;
  try {
    permissions = natsPermissions(check.appId, check.manifest);
  } catch (err) {
    // A stored manifest with an event type the bus can't name: no grant is better than a wrong one.
    log({ msg: "bus.auth.invalid_manifest", app: check.appId, error: (err as Error).message });
    return refuse("invalid_manifest");
  }
  log({
    msg: "bus.auth.granted",
    app: check.appId,
    publish: permissions.publish.length,
    subscribe: permissions.subscribe.length,
  });
  const userJwt = buildUserJwt({
    issuer,
    userNkey,
    appId: check.appId,
    account: deps.account,
    permissions,
    now: now(),
  });
  return buildAuthResponse({ issuer, userNkey, serverId, now: now(), userJwt });
}

export const AUTH_CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

export interface AuthCallout {
  /** Resolves once the responder is subscribed and answering. */
  served: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Connect to the bus as core-api's own (privileged) user and serve every authorization request.
 * While the bus is unreachable it keeps trying (logged, with a backoff), so core-api can start
 * before NATS; once connected it reconnects for ever. The responder is the ONLY thing that can let
 * an app in: if core-api is down, app connects fail with an authorization error, and the app's
 * outbox relay keeps its events and retries (nothing is lost).
 */
export function startAuthCallout(
  deps: CalloutDeps & { servers: string | string[]; user: string; pass: string; name?: string; retryMs?: number },
): AuthCallout {
  const log = deps.log ?? (() => undefined);
  let nc: NatsConnection | undefined;
  let stopped = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let markServed!: () => void;
  const served = new Promise<void>((resolve) => (markServed = resolve));
  const loop = (async () => {
    for (let attempt = 1; !stopped; attempt++) {
      try {
        nc = await connect({
          servers: deps.servers,
          user: deps.user,
          pass: deps.pass,
          name: deps.name ?? "core-api-auth",
          timeout: 3000,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 1000,
        });
        break;
      } catch (err) {
        if (attempt === 1 || attempt % 10 === 0) {
          log({ msg: "bus.auth.unavailable", attempt, error: (err as Error).message });
        }
        await sleep(deps.retryMs ?? 2000);
      }
    }
    if (!nc) return;
    if (stopped) return void (await nc.close());
    const sub = nc.subscribe(AUTH_CALLOUT_SUBJECT);
    log({ msg: "bus.auth.serving", subject: AUTH_CALLOUT_SUBJECT });
    markServed();
    for await (const m of sub) {
      void (async () => {
        try {
          const response = await answerAuthRequest(deps, m.string());
          if (response) m.respond(response);
        } catch (err) {
          log({ msg: "bus.auth.failed", error: (err as Error).message });
        }
      })();
    }
  })();
  return {
    served,
    async stop() {
      stopped = true;
      await nc?.drain().catch(() => undefined);
      await loop.catch(() => undefined);
    },
  };
}

/** A fresh issuer key pair, for the dev key script's twin in tests. */
export function generateIssuer(): { seed: string; publicKey: string } {
  const kp = createAccount();
  return { seed: new TextDecoder().decode(kp.getSeed()), publicKey: kp.getPublicKey() };
}
