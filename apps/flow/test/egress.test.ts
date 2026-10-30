/**
 * lib/egress, the release gate of Flow slice 2 (ADR 0002): against a local HTTPS server with a
 * throwaway certificate for `egress.test` (openssl, at test time), reached through an injected resolver.
 * Loopback is blocked like any private range, so these tests let 127.0.0.1 through as the stand-in
 * for "a public address"; every other check is the real one.
 *
 *  - a name resolving to any blocked range is refused, before a connection;
 *  - DNS rebinding: the name is resolved once and the socket goes to that address;
 *  - redirects aren't followed; http://, other ports and userinfo are refused;
 *  - the request body (256 KiB), the response (1 MiB) and the total time (10 s) are bounded;
 *  - each call is one connector_calls row and one log line, without headers, bodies or the query;
 *  - Pause all stops every call.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isBlockedAddress } from "../lib/egress/address";
import {
  createEgress,
  EgressError,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  pinnedLookup,
  TIMEOUT_MS,
  type EgressDeps,
  type EgressRequest,
  type ResolvedAddress,
} from "../lib/egress/egress";

const HOST = "egress.test";
const LOOPBACK: ResolvedAddress = { address: "127.0.0.1", family: 4 };

let dir: string;
let cert: string;
let key: string;
let server: Server;
let port: number;
/** What the server saw: one entry per request. */
let seen: { method?: string; url?: string; host?: string; servername?: string }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "flow-egress-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      `/CN=${HOST}`,
      "-addext",
      `subjectAltName=DNS:${HOST}`,
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(path.join(dir, "cert.pem"), "utf8");
  key = readFileSync(path.join(dir, "key.pem"), "utf8");
  server = createServer({ cert, key }, (req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      servername: (req.socket as TLSSocket).servername || undefined,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  handler = (_req, res) => res.end("ok");
});

/** A Queryable that answers isPausedAll and keeps the connector_calls rows. */
function fakeDb(pausedAll = false) {
  const rows: unknown[][] = [];
  return {
    rows,
    async query(text: string, values: unknown[] = []) {
      if (text.startsWith("SELECT value FROM settings WHERE key = 'paused_all'"))
        return { rows: pausedAll ? [{ value: true }] : [] };
      if (text.trim().startsWith("INSERT INTO connector_calls")) {
        rows.push(values);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function setup(over: EgressDeps = {}) {
  const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
  const resolved: string[] = [];
  const egress = createEgress({
    resolve: async (h) => {
      resolved.push(h);
      return [LOOPBACK];
    },
    isBlocked: (a) => a !== "127.0.0.1" && isBlockedAddress(a),
    ca: cert,
    log: {
      info: (msg, fields) => logs.push({ msg, fields }),
      warn: (msg, fields) => logs.push({ msg, fields }),
    },
    ...over,
  });
  return { egress, logs, resolved };
}

const call = (over: Partial<EgressRequest> = {}): EgressRequest => ({
  method: "GET",
  url: `https://${HOST}:${port}/hook?token=query-secret`,
  allow: [{ host: HOST, ports: [port] }],
  call: { connector: "webhook-out", runId: "run-1", stepId: "step-1" },
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<EgressError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EgressError) return err;
    throw err;
  }
  throw new Error("expected an EgressError");
}

describe("a call that passes every check", () => {
  it("reaches the host by name (SNI, certificate, Host header) at the checked address, and is recorded", async () => {
    const { egress, logs } = setup();
    const db = fakeDb();
    const res = await egress.request(db, call({ headers: { authorization: "Bearer header-secret" } }));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("ok");
    expect(seen).toEqual([
      { method: "GET", url: "/hook?token=query-secret", host: `${HOST}:${port}`, servername: HOST },
    ]);
    expect(db.rows).toHaveLength(1);
    const [, runId, stepId, connector, host, status, duration, errorCode] = db.rows[0]!;
    expect({ runId, stepId, connector, host, status, errorCode }).toEqual({
      runId: "run-1",
      stepId: "step-1",
      connector: "webhook-out",
      host: HOST,
      status: 200,
      errorCode: null,
    });
    expect(typeof duration).toBe("number");
    expect(logs).toEqual([
      {
        msg: "egress.call",
        fields: expect.objectContaining({ method: "GET", host: HOST, path: "/hook", status: 200 }),
      },
    ]);
    const recorded = JSON.stringify([db.rows, logs]);
    expect(recorded).not.toContain("query-secret");
    expect(recorded).not.toContain("header-secret");
  });

  it("a caller can't set Host, Content-Length or Transfer-Encoding", async () => {
    const { egress } = setup();
    let got: Record<string, unknown> = {};
    handler = (req, res) => {
      got = { ...req.headers };
      req.resume().on("end", () => res.end());
    };
    await egress.request(
      fakeDb(),
      call({ method: "POST", body: "abc", headers: { host: "evil.example", "content-length": "1", "x-a": "1" } }),
    );
    expect(got).toMatchObject({ host: `${HOST}:${port}`, "content-length": "3", "x-a": "1" });
  });
});

describe("the URL", () => {
  const cases: [string, string, EgressRequest["allow"], string][] = [
    ["http://", `http://${HOST}/x`, [{ host: HOST }], "scheme_refused"],
    ["another scheme", `ftp://${HOST}/x`, [{ host: HOST }], "scheme_refused"],
    ["userinfo", `https://user:pass@${HOST}/x`, [{ host: HOST }], "userinfo_refused"],
    ["a user name alone", `https://user@${HOST}/x`, [{ host: HOST }], "userinfo_refused"],
    ["a port its host entry doesn't name", `https://${HOST}:8443/x`, [{ host: HOST }], "port_refused"],
    ["port 80 over https", `https://${HOST}:80/x`, [{ host: HOST, ports: [8443] }], "port_refused"],
    ["a host not on the list", "https://other.example/x", [{ host: HOST }], "host_not_allowed"],
    ["a subdomain of a listed host", `https://a.${HOST}/x`, [{ host: HOST }], "host_not_allowed"],
    ["an IP literal", "https://93.184.216.34/x", [{ host: HOST }], "host_not_allowed"],
    ["an IPv6 literal", "https://[::1]/x", [{ host: HOST }], "host_not_allowed"],
    ["not a URL", "not a url", [{ host: HOST }], "invalid_url"],
  ];

  it.each(cases)("%s is refused, nothing resolved or sent", async (_what, url, allow, code) => {
    const { egress, resolved } = setup();
    const db = fakeDb();
    expect((await refusal(egress.request(db, call({ url, allow })))).code).toBe(code);
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
    expect(db.rows[0]![7]).toBe(code);
  });

  it("an error message names the code and the host, never the URL", async () => {
    const { egress } = setup();
    const e = await refusal(egress.request(fakeDb(), call({ url: `https://u:p4ss@${HOST}/x?k=secret-q` })));
    expect(e.message).toBe(`Egress userinfo_refused (${HOST})`);
  });
});

describe("the address", () => {
  const BLOCKED = [
    "127.0.0.2", // loopback
    "10.1.2.3", // RFC 1918
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "100.127.255.254",
    "169.254.169.254", // link-local, cloud metadata
    "169.254.0.1",
    "224.0.0.1", // multicast
    "239.255.255.250",
    "0.0.0.0", // unspecified
    "255.255.255.255", // broadcast
    "::1",
    "::",
    "fc00::1", // ULA
    "fd12:3456::1",
    "fe80::1", // link-local
    "fe80::1%eth0",
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::10.0.0.1", // NAT64
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1", // NAT64, local use
    "::127.0.0.1", // IPv4-compatible
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "2002:a00:1::", // 6to4 of 10.0.0.1
  ];

  it.each(BLOCKED)("a host resolving to %s is refused before any connection", async (address) => {
    const { egress } = setup({
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      isBlocked: isBlockedAddress,
    });
    const db = fakeDb();
    expect((await refusal(egress.request(db, call()))).code).toBe("address_refused");
    expect(seen).toEqual([]);
    expect(db.rows[0]![7]).toBe("address_refused");
  });

  it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "%s is public",
    (address) => expect(isBlockedAddress(address)).toBe(false),
  );

  it("a name with one private address among public ones is refused", async () => {
    const { egress } = setup({
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      isBlocked: isBlockedAddress,
    });
    expect((await refusal(egress.request(fakeDb(), call()))).code).toBe("address_refused");
  });

  it("a name that doesn't resolve is dns_failed", async () => {
    const { egress } = setup({
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect((await refusal(egress.request(fakeDb(), call()))).code).toBe("dns_failed");
  });
});

describe("DNS rebinding", () => {
  it("first answer public, second private: the name is resolved once, the socket goes to the first", async () => {
    const answers = [LOOPBACK, { address: "10.0.0.1", family: 4 as const }];
    let n = 0;
    const { egress } = setup({ resolve: async () => [answers[Math.min(n++, 1)]!] });
    const res = await egress.request(fakeDb(), call());
    expect(res.status).toBe(200);
    expect(n).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("the pinned lookup answers the checked addresses whatever it is asked, in both callback forms", () => {
    const lookup = pinnedLookup([
      { address: "2606:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]) as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void;
    const single: unknown[] = [];
    lookup("rebound.example", {}, (...a) => single.push(...a));
    expect(single).toEqual([null, "2606:4700::1111", 6]);
    const all: unknown[] = [];
    lookup("rebound.example", { all: true }, (...a) => all.push(...a));
    expect(all).toEqual([
      null,
      [
        { address: "2606:4700::1111", family: 6 },
        { address: "8.8.8.8", family: 4 },
      ],
    ]);
  });

  it("an IPv6 address without a route first: the next checked address is tried, no new DNS query", async () => {
    let n = 0;
    const { egress } = setup({
      resolve: async () => {
        n++;
        // ::1 (nothing listens there) stands in for an IPv6 address this host can't reach.
        return [{ address: "::1", family: 6 }, LOOPBACK];
      },
      isBlocked: () => false,
    });
    expect((await egress.request(fakeDb(), call())).status).toBe(200);
    expect(n).toBe(1);
  });
});

describe("redirects", () => {
  it.each([301, 302, 303, 307, 308])("a %i is refused, its Location never requested", async (status) => {
    handler = (_req, res) => {
      res.writeHead(status, { location: `https://${HOST}:${port}/elsewhere` });
      res.end();
    };
    const { egress } = setup();
    const db = fakeDb();
    const e = await refusal(egress.request(db, call()));
    expect(e).toMatchObject({ code: "redirect_refused", status });
    expect(seen.map((s) => s.url)).toEqual(["/hook?token=query-secret"]);
    expect(db.rows[0]!.slice(5)).toEqual([status, expect.any(Number), "redirect_refused"]);
  });
});

describe("limits", () => {
  it("are 10 s, 256 KiB and 1 MiB", () => {
    expect([TIMEOUT_MS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES]).toEqual([10_000, 256 * 1024, 1024 * 1024]);
  });

  it("a request body over 256 KiB is refused before anything is resolved", async () => {
    const { egress, resolved } = setup();
    const e = await refusal(
      egress.request(fakeDb(), call({ method: "POST", body: "x".repeat(MAX_REQUEST_BYTES + 1) })),
    );
    expect(e.code).toBe("request_too_large");
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a body of exactly 256 KiB goes", async () => {
    let size = 0;
    handler = (req, res) => {
      req.on("data", (c: Buffer) => (size += c.length)).on("end", () => res.end());
    };
    const { egress } = setup();
    await egress.request(fakeDb(), call({ method: "POST", body: new Uint8Array(MAX_REQUEST_BYTES) }));
    expect(size).toBe(MAX_REQUEST_BYTES);
  });

  it("a response announcing more than 1 MiB is aborted", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": String(MAX_RESPONSE_BYTES + 1) });
      res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    };
    const { egress } = setup();
    expect(await refusal(egress.request(fakeDb(), call()))).toMatchObject({ code: "response_too_large", status: 200 });
  });

  it("a chunked response is cut once it passes 1 MiB", async () => {
    let sent = 0;
    handler = (_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024);
      const more = () => {
        while (sent < 4 * MAX_RESPONSE_BYTES && !res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", more);
        }
        res.end();
      };
      res.on("error", () => undefined);
      more();
    };
    const { egress } = setup();
    expect((await refusal(egress.request(fakeDb(), call()))).code).toBe("response_too_large");
    expect(sent).toBeLessThan(4 * MAX_RESPONSE_BYTES);
  });

  it("a response of exactly 1 MiB is read", async () => {
    handler = (_req, res) => res.end(Buffer.alloc(MAX_RESPONSE_BYTES));
    const { egress } = setup();
    expect((await egress.request(fakeDb(), call())).body.length).toBe(MAX_RESPONSE_BYTES);
  });

  it("the time limit is total: a server that keeps sending slowly is cut", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write("x")), 20);
      res.on("close", () => clearInterval(t));
    };
    const { egress } = setup({ timeoutMs: 300 });
    const started = Date.now();
    expect((await refusal(egress.request(fakeDb(), call()))).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a server that never answers times out", async () => {
    handler = () => undefined;
    const { egress } = setup({ timeoutMs: 300 });
    const db = fakeDb();
    expect(await refusal(egress.request(db, call()))).toMatchObject({ code: "timeout", host: HOST });
    expect(db.rows[0]![7]).toBe("timeout");
  });

  it("DNS counts against the time limit", async () => {
    const { egress } = setup({ timeoutMs: 200, resolve: () => new Promise(() => undefined) });
    expect((await refusal(egress.request(fakeDb(), call()))).code).toBe("timeout");
  });

  it("a caller may set its own time limit for one call", async () => {
    handler = () => undefined;
    const { egress } = setup({ timeoutMs: 60_000 });
    const started = Date.now();
    expect((await refusal(egress.request(fakeDb(), { ...call(), timeoutMs: 200 }))).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a caller's time limit is capped at 2 minutes", () => {
    expect(MAX_TIMEOUT_MS).toBe(120_000);
  });
});

describe("Pause all", () => {
  it("stops every call before it resolves anything", async () => {
    const { egress, resolved } = setup();
    expect((await refusal(egress.request(fakeDb(true), call()))).code).toBe("paused_all");
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("TLS", () => {
  it("a certificate that isn't trusted fails the call (no fallback, no insecure retry)", async () => {
    const { egress } = setup({ ca: undefined });
    expect((await refusal(egress.request(fakeDb(), call()))).code).toBe("connect_failed");
  });
});
