/**
 * ULIDs (https://github.com/ulid/spec): 48 bits of milliseconds + 80 random bits, Crockford base32,
 * 26 characters. Lexicographic order follows creation time, which makes them readable in logs and
 * usable as the JetStream de-duplication key (`Nats-Msg-Id`).
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) throw new RangeError(`ulid: bad time ${now}`);
  if (random.length !== 10) throw new RangeError("ulid: needs 10 random bytes");
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  // 80 bits → 16 base32 characters, 5 bits at a time.
  let bits = 0n;
  for (const b of random) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(bits & 31n)]! + rand;
    bits >>= 5n;
  }
  return time + rand;
}
