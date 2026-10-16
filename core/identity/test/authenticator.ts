/**
 * A software passkey for tests: makes the attestation and assertion responses a browser would
 * send, signed with a real key (ES256 by default), so the server's checks run on real bytes.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function encodeCbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export interface SoftPasskeyOptions {
  rpId: string;
  origin: string;
  alg?: -7 | -8;
  /** Leave the user-verified flag off (an authenticator that only checked presence). */
  noUserVerification?: boolean;
  /** Keep the counter at 0 (many platform authenticators do). */
  noCounter?: boolean;
}

export class SoftPasskey {
  readonly id: Buffer = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly cose: Map<Cbor, Cbor>;
  counter = 0;
  userHandle: string | null = null;

  private readonly o: SoftPasskeyOptions;

  constructor(o: SoftPasskeyOptions) {
    this.o = o;
    if ((o.alg ?? -7) === -8) {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      this.privateKey = privateKey;
      const jwk = publicKey.export({ format: "jwk" }) as { x: string };
      this.cose = new Map<Cbor, Cbor>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, Buffer.from(jwk.x, "base64url")],
      ]);
    } else {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      this.privateKey = privateKey;
      const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
      this.cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]);
    }
  }

  private authData(withCredential: boolean, rpId = this.o.rpId): Buffer {
    const flags = 0x01 | (this.o.noUserVerification ? 0 : 0x04) | (withCredential ? 0x40 : 0);
    if (!this.o.noCounter) this.counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.o.noCounter ? 0 : this.counter);
    const parts: Uint8Array[] = [sha256(rpId), Buffer.from([flags]), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, Buffer.from(this.id), encodeCbor(this.cose));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin = this.o.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What navigator.credentials.create() would give the page, encoded as our script posts it. */
  create(options: { challenge: string; user: { id: string } }, over: { origin?: string; rpId?: string } = {}) {
    this.userHandle = Buffer.from(options.user.id, "base64url").toString("utf8");
    const attestation = encodeCbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(true, over.rpId)],
      ]),
    );
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, over.origin)),
        attestationObject: b64u(attestation),
        transports: ["internal"],
      },
    };
  }

  /** What navigator.credentials.get() would give the page. */
  get(options: { challenge: string }, over: { origin?: string; tamper?: boolean } = {}) {
    const authData = this.authData(false);
    const clientData = this.clientData("webauthn.get", options.challenge, over.origin);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature =
      (this.o.alg ?? -7) === -8 ? sign(null, signed, this.privateKey) : sign("sha256", signed, this.privateKey);
    if (over.tamper) signature[signature.length - 1] = signature[signature.length - 1]! ^ 1;
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle ? b64u(Buffer.from(this.userHandle, "utf8")) : null,
      },
    };
  }
}
