/**
 * Which addresses Flow may connect to: public unicast only. Every range below is refused, and so is
 * an IPv6 address that carries one of them inside it (IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible
 * ::a.b.c.d, NAT64 64:ff9b::a.b.c.d, 6to4 2002:aabb:ccdd::). An address that doesn't parse is refused.
 */
import { isIP } from "node:net";

/** [first address as a number, prefix length]. */
type V4Range = readonly [string, number];

const BLOCKED_V4: readonly V4Range[] = [
  ["0.0.0.0", 8], // "this network", the unspecified address
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address 255.255.255.255
];

/** [first address, prefix length]; checked on the 128-bit value. */
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ["::", 96], // the unspecified address, ::1, and the deprecated IPv4-compatible form
  ["64:ff9b:1::", 48], // NAT64, local use
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

function v4ToInt(addr: string): number | undefined {
  const parts = addr.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const b = Number(p);
    if (b > 255) return undefined;
    n = n * 256 + b;
  }
  return n;
}

function v4Blocked(n: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base)!;
    return n >= start && n < start + size;
  });
}

/** The 128-bit value of an IPv6 address (with or without an embedded dotted IPv4 tail). */
function v6ToBigInt(addr: string): bigint | undefined {
  let s = addr.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A dotted IPv4 tail is the last two hextets.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = v4ToInt(tail);
    if (n === undefined) return undefined;
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

const inV6 = (n: bigint, base: string, bits: number) => {
  const shift = BigInt(128 - bits);
  return n >> shift === v6ToBigInt(base)! >> shift;
};

function v6Blocked(n: bigint): boolean {
  // An IPv4 address inside IPv6: judged as that IPv4 address.
  const low32 = Number(n & 0xffffffffn);
  if (inV6(n, "::ffff:0:0", 96)) return v4Blocked(low32); // IPv4-mapped
  if (inV6(n, "64:ff9b::", 96)) return v4Blocked(low32); // NAT64, well-known prefix
  if (inV6(n, "2002::", 16)) return v4Blocked(Number((n >> 80n) & 0xffffffffn)); // 6to4
  return BLOCKED_V6.some(([base, bits]) => inV6(n, base, bits));
}

/** True unless `address` (an IP literal) is a public unicast address Flow may connect to. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.split("%")[0]!);
  if (family === 4) {
    const n = v4ToInt(address);
    return n === undefined || v4Blocked(n);
  }
  if (family === 6) {
    const n = v6ToBigInt(address);
    return n === undefined || v6Blocked(n);
  }
  return true;
}
