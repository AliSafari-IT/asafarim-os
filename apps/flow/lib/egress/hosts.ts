/**
 * The allow-list a call is checked against: a connector's fixed hosts, or the Settings `egress_hosts`
 * list (webhook out). A host is a DNS name, matched exactly (no wildcards), lower case; port 443 is
 * always allowed, another port only when the entry names it ("hooks.example.com:8443").
 */
import { isIP } from "node:net";

/** The ports an SMTP credential may name (SMTPS, submission), except a loopback server without TLS (development). */
export const SMTP_PORTS: readonly number[] = [465, 587];

export interface AllowedHost {
  host: string;
  /** Ports besides 443. */
  ports?: readonly number[];
}

/** A DNS name: labels of letters, digits and hyphens, at least one dot, at most 253 characters. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
export function isHostName(host: string): boolean {
  if (host.length > 253 || isIP(host)) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1)!);
}

/** One Settings entry ("host" or "host:port"), or undefined when it isn't one. */
export function parseHostEntry(raw: string): AllowedHost | undefined {
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(raw.trim().toLowerCase());
  if (!m || !isHostName(m[1]!)) return undefined;
  if (m[2] === undefined) return { host: m[1]! };
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return undefined;
  return port === 443 ? { host: m[1]! } : { host: m[1]!, ports: [port] };
}

/** Settings entries to an allow-list: entries that don't parse are dropped, the same host merged. */
export function allowListOf(entries: readonly string[]): AllowedHost[] {
  const byHost = new Map<string, Set<number>>();
  for (const e of entries) {
    const h = parseHostEntry(e);
    if (!h) continue;
    const ports = byHost.get(h.host) ?? new Set<number>();
    for (const p of h.ports ?? []) ports.add(p);
    byHost.set(h.host, ports);
  }
  return [...byHost].map(([host, ports]) => (ports.size ? { host, ports: [...ports] } : { host }));
}

/** Whether `host:port` is on the list. */
export function isAllowed(allow: readonly AllowedHost[], host: string, port: number): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => a.host.toLowerCase() === h && (port === 443 || (a.ports ?? []).includes(port)));
}
