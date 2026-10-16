/**
 * A minimal CBOR decoder (RFC 8949) for what WebAuthn sends: the attestation
 * object and COSE public keys. Definite lengths only (WebAuthn never uses
 * indefinite ones), no tags, no floats. Anything else is refused.
 */
export type CborValue = number | boolean | null | undefined | string | Uint8Array | CborValue[] | CborMap;
export type CborMap = Map<CborValue, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 1024;

/** Decodes one item at `offset`; returns it and where it ends (COSE keys are followed by other data). */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  let pos = offset;

  const need = (n: number) => {
    if (pos + n > bytes.length) throw new CborError("truncated");
  };

  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[pos++]!;
    }
    if (info === 25) {
      need(2);
      const v = (bytes[pos]! << 8) | bytes[pos + 1]!;
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = bytes[pos]! * 2 ** 24 + (bytes[pos + 1]! << 16) + (bytes[pos + 2]! << 8) + bytes[pos + 3]!;
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[pos + i]!);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("integer too large");
      return Number(v);
    }
    throw new CborError("indefinite or reserved length");
  };

  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError("too deep");
    need(1);
    const initial = bytes[pos++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const n = readLength(info);
        need(n);
        const out = bytes.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = readLength(info);
        need(n);
        const out = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = readLength(info);
        if (n > MAX_ITEMS) throw new CborError("too many items");
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = readLength(info);
        if (n > MAX_ITEMS) throw new CborError("too many items");
        const out: CborMap = new Map();
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1);
          if (out.has(key)) throw new CborError("duplicate key");
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new CborError("unsupported simple value or float");
      default:
        throw new CborError("unsupported major type (tag)");
    }
  };

  const value = item(0);
  return { value, end: pos };
}
