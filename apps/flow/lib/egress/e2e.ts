/**
 * The end-to-end tests' routes (scripts/dev/e2e.mjs sets them; nothing else does): GitHub, the email
 * server and the webhook receiver are local mocks there, and Flow reaches them through lib/egress like
 * anything else. Two variables, both needed:
 *
 *   FLOW_E2E_EGRESS     "api.github.com:443=4193,smtp.e2e.test:465=4195,…": a call for that host and port
 *                       connects to 127.0.0.1 on the port after "=". Only a port can be given: a route
 *                       never leads anywhere but this machine's loopback.
 *   FLOW_E2E_EGRESS_CA  a PEM file: the certificate the mocks serve (made for each run by the e2e). The
 *                       mock still has to prove the host's name with it; nothing is trusted otherwise.
 *
 * Everything else is checked as always: https, the allow-list (a connector's hosts, Settings
 * `egress_hosts`), the port, the certificate for the host's name, paused_all, the record. Without
 * FLOW_E2E_EGRESS there is no route and no extra CA, and its being on is logged when it is read.
 */
import { readFileSync } from "node:fs";
import type { EgressRoute } from "./egress";

const ENTRY = /^([a-z0-9.-]+):(\d{1,5})=(\d{1,5})$/;
const LOOPBACK = [{ address: "127.0.0.1", family: 4 as const }];

export interface E2eEgress {
  route: (host: string, port: number) => EgressRoute | undefined;
  ca: Buffer;
  hosts: string[];
}

/** The routes and the CA, or undefined when FLOW_E2E_EGRESS isn't set. Throws on a malformed entry or a missing CA. */
export function e2eEgress(env: Record<string, string | undefined> = process.env): E2eEgress | undefined {
  const raw = env.FLOW_E2E_EGRESS?.trim();
  if (!raw) return undefined;
  const routes = new Map<string, number>();
  for (const entry of raw.split(",").map((e) => e.trim().toLowerCase())) {
    const m = ENTRY.exec(entry);
    const from = Number(m?.[2]);
    const to = Number(m?.[3]);
    if (!m || from < 1 || from > 65535 || to < 1 || to > 65535)
      throw new Error(`FLOW_E2E_EGRESS: "${entry}" isn't host:port=port`);
    routes.set(`${m[1]}:${from}`, to);
  }
  if (!env.FLOW_E2E_EGRESS_CA) throw new Error("FLOW_E2E_EGRESS needs FLOW_E2E_EGRESS_CA");
  const ca = readFileSync(env.FLOW_E2E_EGRESS_CA);
  return {
    ca,
    hosts: [...routes.keys()],
    route(host, port) {
      const to = routes.get(`${host.toLowerCase()}:${port}`);
      return to === undefined ? undefined : { port: to, addresses: LOOPBACK, ca };
    },
  };
}
