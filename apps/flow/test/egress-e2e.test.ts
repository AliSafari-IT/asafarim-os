/**
 * The end-to-end tests' routes (lib/egress/e2e.ts): off without FLOW_E2E_EGRESS; with it, a listed
 * host and port reach a local server (and only 127.0.0.1), whose certificate must still prove the name;
 * the allow-list and every other check still apply. Real HTTPS and SMTP servers, with the certificate
 * the e2e makes (scripts/dev/e2e-tls.mjs, openssl).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eEgress } from "../lib/egress/e2e";
import { createEgress, EgressError } from "../lib/egress/egress";
import { createSmtpEgress, SmtpEgressError } from "../lib/egress/smtp";
// @ts-expect-error: a plain .mjs script, no types.
import { makeE2eCert } from "../../../scripts/dev/e2e-tls.mjs";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
/** No settings row: not paused. The record's insert goes nowhere. */
const q = { query: async () => ({ rows: [] }) };
const log = { info: () => undefined, warn: () => undefined };
const call = { connector: "test" };

describe("FLOW_E2E_EGRESS", () => {
  it("is off without it: no route, no CA", () => {
    expect(e2eEgress({})).toBeUndefined();
    expect(e2eEgress({ FLOW_E2E_EGRESS: " " })).toBeUndefined();
  });

  it("takes host:port=port only: a route can't name an address", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flow-e2e-"));
    const ca = path.join(dir, "ca.pem");
    writeFileSync(ca, "not checked here");
    for (const bad of ["api.github.com=4193", "api.github.com:443=10.0.0.1:4193", "x:443=99999", "a b:443=1"])
      expect(() => e2eEgress({ FLOW_E2E_EGRESS: bad, FLOW_E2E_EGRESS_CA: ca })).toThrow(/host:port=port/);
    expect(() => e2eEgress({ FLOW_E2E_EGRESS: "api.github.com:443=4193" })).toThrow(/FLOW_E2E_EGRESS_CA/);
    const e2e = e2eEgress({ FLOW_E2E_EGRESS: "API.github.com:443=4193", FLOW_E2E_EGRESS_CA: ca })!;
    expect(e2e.route("api.github.com", 443)).toMatchObject({ port: 4193, addresses: [{ address: "127.0.0.1" }] });
    expect(e2e.route("api.github.com", 8443)).toBeUndefined();
    expect(e2e.route("example.com", 443)).toBeUndefined();
  });
});

describe.skipIf(!hasOpenssl)("a routed call (real servers, the e2e's certificate)", () => {
  let https: Server;
  let smtp: ReturnType<typeof createTlsServer>;
  let tls: { key: Buffer; cert: Buffer };
  let caPath: string;
  const mail: string[] = [];
  const port = (s: { address(): unknown }) => (s.address() as AddressInfo).port;

  beforeAll(async () => {
    const files = makeE2eCert(mkdtempSync(path.join(tmpdir(), "flow-e2e-tls-"))) as { key: string; cert: string };
    tls = { key: readFileSync(files.key), cert: readFileSync(files.cert) };
    caPath = files.cert;
    https = createServer(tls, (req, res) => res.end(JSON.stringify({ host: req.headers.host, path: req.url })));
    smtp = createTlsServer(tls, (socket) => {
      socket.write("220 e2e\r\n");
      let data = false;
      socket.on("data", (chunk) => {
        for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
          if (data) {
            if (line === ".") {
              data = false;
              socket.write("250 OK id=1\r\n");
            } else mail.push(line);
          } else if (/^EHLO/.test(line)) socket.write("250-e2e\r\n250 AUTH PLAIN\r\n");
          else if (/^AUTH/.test(line)) socket.write("235 ok\r\n");
          else if (line === "DATA") {
            data = true;
            socket.write("354 go\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    });
    await Promise.all([
      new Promise<void>((r) => https.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r)),
    ]);
  });
  afterAll(() => {
    https?.close();
    smtp?.close();
  });

  const routes = () =>
    e2eEgress({
      FLOW_E2E_EGRESS: `api.github.com:443=${port(https)},smtp.e2e.test:465=${port(smtp)},elsewhere.e2e.test:443=${port(https)}`,
      FLOW_E2E_EGRESS_CA: caPath,
    })!;

  it("HTTPS: a listed host reaches the local server, with SNI and Host for its name", async () => {
    const egress = createEgress({ route: routes().route, log });
    const res = await egress.request(q, {
      method: "GET",
      url: "https://api.github.com/user?x=1",
      allow: [{ host: "api.github.com" }],
      call,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString())).toEqual({ host: `api.github.com:${port(https)}`, path: "/user?x=1" });
  });

  it("the allow-list still applies to a routed host, and the certificate must prove the name", async () => {
    const egress = createEgress({ route: routes().route, log });
    await expect(
      egress.request(q, { method: "GET", url: "https://api.github.com/", allow: [{ host: "other.example" }], call }),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    // elsewhere.e2e.test is routed, but the certificate isn't for that name.
    await expect(
      egress.request(q, {
        method: "GET",
        url: "https://elsewhere.e2e.test/",
        allow: [{ host: "elsewhere.e2e.test" }],
        call,
      }),
    ).rejects.toBeInstanceOf(EgressError);
  });

  it("SMTP over TLS: the routed server gets the message; without TLS there is no route", async () => {
    const smtpEgress = createSmtpEgress({ route: routes().route, log, env: { NODE_ENV: "production" } });
    const server = { host: "smtp.e2e.test", port: 465, mode: "tls" as const, username: "u", password: "p" };
    const message = { from: "flow@example.com", to: ["ops@example.com"], subject: "Hi", text: "Hello" };
    await smtpEgress.send(q, { server, message, call });
    expect(mail.some((l) => l === "Subject: Hi")).toBe(true);
    await expect(smtpEgress.send(q, { server: { ...server, mode: "none" }, message, call })).rejects.toBeInstanceOf(
      SmtpEgressError,
    );
  });
});
