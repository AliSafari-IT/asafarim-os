/**
 * The e2e's TLS certificate (scripts/dev/e2e.mjs): one self-signed certificate, made fresh for each
 * run, for the names Flow's mocks answer as (apps/flow/e2e/mocks.mjs). The mocks serve it; Flow trusts
 * it only for the hosts FLOW_E2E_EGRESS routes to them (apps/flow/lib/egress/e2e.ts). Its key never
 * leaves the run's folder, and nothing outside the e2e trusts it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** The names the mocks answer as. */
export const E2E_TLS_NAMES = ["api.github.com", "api.anthropic.com", "hooks.e2e.test", "smtp.e2e.test", "localhost"];

/** Make the key and certificate in `dir` (openssl); their paths. */
export function makeE2eCert(dir) {
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=flow-e2e",
      "-addext",
      `subjectAltName=${E2E_TLS_NAMES.map((n) => `DNS:${n}`).join(",")}`,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`openssl couldn't make the e2e certificate: ${r.stderr || r.error}`);
  return { key, cert };
}
