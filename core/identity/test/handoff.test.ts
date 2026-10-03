import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ASSERTION_AUDIENCE,
  ASSERTION_ISSUER,
  HandoffError,
  TICKET_TTL_SECONDS,
  issueTicket,
  verifyAssertion,
  verifyTicket,
  type ReplayGuard,
} from "../src/handoff.ts";

type Pair = Awaited<ReturnType<typeof generateKeyPair>>;

class MemoryReplay implements ReplayGuard {
  readonly seen = new Set<string>();
  async claimOnce(jti: string) {
    if (this.seen.has(jti)) return false;
    this.seen.add(jti);
    return true;
  }
}

let hub: Pair;
let other: Pair;
let identity: Pair;

beforeAll(async () => {
  hub = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  identity = await generateKeyPair("EdDSA", { crv: "Ed25519" });
});

const NOW = new Date("2026-10-04T10:00:00Z");
const iat = Math.floor(NOW.getTime() / 1000);

function assertion(over: Record<string, unknown> = {}, key = hub.privateKey) {
  const claims = {
    iss: ASSERTION_ISSUER,
    aud: ASSERTION_AUDIENCE,
    sub: "user-1",
    uid: "uid-1",
    jti: "jti-1",
    iat,
    exp: iat + 60,
    ...over,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).sign(key);
}

async function refusal(token: Promise<string> | string, opts: { uid?: string; replay?: ReplayGuard; now?: Date } = {}) {
  try {
    await verifyAssertion(await token, {
      hubPublicKey: hub.publicKey,
      uid: opts.uid ?? "uid-1",
      replay: opts.replay ?? new MemoryReplay(),
      now: opts.now ?? NOW,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(HandoffError);
    return (err as HandoffError).code;
  }
  return "accepted";
}

describe("Hub assertion verifier (ADR 0002, A2)", () => {
  it("accepts a valid assertion and returns its sub", async () => {
    const r = await verifyAssertion(await assertion(), {
      hubPublicKey: hub.publicKey,
      uid: "uid-1",
      replay: new MemoryReplay(),
      now: NOW,
    });
    expect(r).toEqual({ sub: "user-1" });
  });

  it("refuses the wrong audience", async () => {
    expect(await refusal(assertion({ aud: "hub" }))).toBe("wrong_audience");
  });

  it("refuses an expired assertion", async () => {
    expect(await refusal(assertion(), { now: new Date(NOW.getTime() + 61_000) })).toBe("expired");
  });

  it("refuses a replayed jti", async () => {
    const replay = new MemoryReplay();
    const token = await assertion();
    expect(await refusal(token, { replay })).toBe("accepted");
    expect(await refusal(token, { replay })).toBe("replayed");
  });

  it("refuses an assertion for a different interaction uid", async () => {
    expect(await refusal(assertion(), { uid: "uid-2" })).toBe("wrong_uid");
  });

  it("refuses a bad signature (a key other than Hub's pinned key)", async () => {
    expect(await refusal(assertion({}, other.privateKey))).toBe("bad_signature");
  });

  it("refuses the wrong issuer, a missing jti, and a lifetime over 60 s", async () => {
    expect(await refusal(assertion({ iss: "id" }))).toBe("invalid");
    expect(await refusal(assertion({ jti: undefined }))).toBe("invalid");
    expect(await refusal(assertion({ exp: iat + 61 }))).toBe("invalid");
  });

  it("doesn't consume the jti of a refused assertion", async () => {
    const replay = new MemoryReplay();
    await refusal(assertion(), { uid: "uid-2", replay });
    expect(replay.seen.size).toBe(0);
  });
});

describe("identity → Hub ticket", () => {
  it("is EdDSA, aud=hub, bound to the uid, with a nonce, and lives at most 120 s", async () => {
    const ticket = await issueTicket("uid-9", identity.privateKey, NOW);
    const { uid, nonce } = await verifyTicket(ticket, identity.publicKey, NOW);
    expect(uid).toBe("uid-9");
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    await expect(
      verifyTicket(ticket, identity.publicKey, new Date(NOW.getTime() + (TICKET_TTL_SECONDS + 1) * 1000)),
    ).rejects.toMatchObject({
      code: "expired",
    });
    await expect(verifyTicket(ticket, other.publicKey, NOW)).rejects.toMatchObject({ code: "bad_signature" });
  });
});
