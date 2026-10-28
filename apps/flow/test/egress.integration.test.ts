/**
 * Slice 2's tables on a REAL Postgres: migration 3, the credential store (bytea round trip, AAD,
 * last_used_at, the name unique), the key rotation script end to end, the settings and the kill
 * switch, an egress call recorded in connector_calls without its query, and the email connector's rate
 * limits on email_sends (migration 5) with the credential used through the pool.
 *
 * Needs FLOW_TEST_ADMIN_URL (or EVENTS_TEST_ADMIN_URL): a superuser URL on a DEV Postgres. Skipped
 * without it. It uses a throwaway database, dropped afterwards.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyringFromEnv, type Keyring } from "../lib/credentials/cipher";
import { createCredential, listCredentials, useCredential } from "../lib/credentials/store";
import { createEgress, EgressError } from "../lib/egress/egress";
import { EMAIL_LIMIT_PER_WORKFLOW, EMAIL_SEND } from "../lib/connectors/email";
import { poolDb, servicesFor, type ConnectorContext, type ConnectorError } from "../lib/engine/connectors";
import { migrate } from "../lib/migrations";
import { getSettings, isPausedAll, setList, setPausedAll } from "../lib/settings";

const ADMIN_URL = process.env.FLOW_TEST_ADMIN_URL ?? process.env.EVENTS_TEST_ADMIN_URL;
const dbName = `flow_egress_test_${Date.now().toString(36)}`;
const KEY1 = randomBytes(32).toString("base64");
const KEY2 = randomBytes(32).toString("base64");
const keyring = (env: Record<string, string>): Keyring => {
  const s = keyringFromEnv(env);
  if (!s.ok) throw new Error(s.reason);
  return s.keyring;
};

describe.skipIf(!ADMIN_URL)("slice 2 on Postgres (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let url: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("stores a credential sealed, lists it without the secret, and opens it only with its own id", async () => {
    const K1 = keyring({ FLOW_CREDENTIALS_KEY: KEY1 });
    const r = await createCredential(
      pool,
      { kind: "github-token", name: "GitHub", meta: { repos: ["o/r"] }, secret: { token: "ghp_integration" } },
      "dev-owner",
      K1,
    );
    if (!r.ok) throw new Error(r.error);
    const raw = await pool.query("SELECT ciphertext, iv, key_version, meta::text FROM credentials WHERE id = $1", [
      r.id,
    ]);
    expect(raw.rows[0].iv).toHaveLength(12);
    expect(raw.rows[0].key_version).toBe(1);
    expect(Buffer.from(raw.rows[0].ciphertext).includes("ghp_integration")).toBe(false);
    expect(raw.rows[0].meta).not.toContain("ghp_integration");
    expect(JSON.stringify(await listCredentials(pool))).not.toContain("ghp_integration");
    expect((await useCredential(pool, r.id, "github-token", K1)).token).toBe("ghp_integration");
    expect((await listCredentials(pool))[0]!.lastUsedAt).toBeInstanceOf(Date);
    expect(await createCredential(pool, { kind: "webhook-secret", name: "GitHub" }, "dev-owner", K1)).toMatchObject({
      ok: false,
      error: "credential_name_taken",
    });

    // The ciphertext moved onto another credential's row doesn't open there.
    const other = await createCredential(pool, { kind: "webhook-secret", name: "Hook" }, "dev-owner", K1);
    if (!other.ok) throw new Error(other.error);
    await pool.query("UPDATE credentials SET kind = 'github-token', ciphertext = $2, iv = $3 WHERE id = $1", [
      other.id,
      raw.rows[0].ciphertext,
      raw.rows[0].iv,
    ]);
    await expect(useCredential(pool, other.id, "github-token", K1)).rejects.toMatchObject({
      code: "credential_unreadable",
    });
    await pool.query("DELETE FROM credentials WHERE id = $1", [other.id]);
  });

  it("the rotation script re-encrypts every row under the new key", async () => {
    const env = {
      ...process.env,
      DATABASE_URL: url,
      FLOW_CREDENTIALS_KEY: KEY2,
      FLOW_CREDENTIALS_KEY_VERSION: "2",
      FLOW_CREDENTIALS_PREVIOUS_KEYS: `1:${KEY1}`,
    };
    const script = path.resolve(import.meta.dirname, "../scripts/rotate-credentials-key.mjs");
    const { stdout } = await promisify(execFile)(process.execPath, [script], { env });
    expect(stdout).toContain("Re-encrypted 1 credential(s) under key version 2.");
    expect(stdout).not.toContain(KEY2);
    const { rows } = await pool.query("SELECT id, key_version FROM credentials");
    expect(rows.map((r) => r.key_version)).toEqual([2]);
    const only2 = keyring({ FLOW_CREDENTIALS_KEY: KEY2, FLOW_CREDENTIALS_KEY_VERSION: "2" });
    expect((await useCredential(pool, rows[0].id, "github-token", only2)).token).toBe("ghp_integration");
  });

  it("settings: lists and the kill switch; egress refuses while paused and records the call", async () => {
    expect(await getSettings(pool)).toEqual({ egressHosts: [], emailRecipients: [], pausedAll: false });
    await setList(pool, "egress_hosts", ["hooks.example.com", "hooks.example.com:8443"], "dev-owner");
    await setList(pool, "email_recipients", ["@example.com"], "dev-owner");
    await setPausedAll(pool, true, "dev-owner");
    expect(await getSettings(pool)).toEqual({
      egressHosts: ["hooks.example.com", "hooks.example.com:8443"],
      emailRecipients: ["@example.com"],
      pausedAll: true,
    });
    expect(await isPausedAll(pool)).toBe(true);

    const egress = createEgress({ log: { info: () => undefined, warn: () => undefined } });
    await expect(
      egress.request(pool, {
        method: "POST",
        url: "https://hooks.example.com/in?sig=query-secret",
        allow: [{ host: "hooks.example.com" }],
        call: { connector: "webhook-out", runId: "run-1", stepId: "step-1" },
      }),
    ).rejects.toBeInstanceOf(EgressError);
    const { rows } = await pool.query("SELECT * FROM connector_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: "run-1",
      step_id: "step-1",
      connector: "webhook-out",
      host: "hooks.example.com",
      status: null,
      error_code: "paused_all",
    });
    expect(JSON.stringify(rows)).not.toContain("query-secret");
    await setPausedAll(pool, false, "dev-owner");
    expect(await isPausedAll(pool)).toBe(false);
  });
  it("email.send on Postgres: the credential opened with the pool, a place in email_sends, the limit per workflow", async () => {
    const K1 = keyring({ FLOW_CREDENTIALS_KEY: KEY1 });
    const cred = await createCredential(
      pool,
      {
        kind: "smtp",
        name: "Mail",
        meta: { host: "smtp.example.com", port: 587, mode: "starttls", from: "flow@example.com" },
        secret: { username: "u", password: "smtp-integration-pass" },
      },
      "dev-owner",
      K1,
    );
    if (!cred.ok) throw new Error(cred.error);
    await setList(pool, "email_recipients", ["@example.com"], "dev-owner");
    await setPausedAll(pool, false, "dev-owner");
    const sent: unknown[] = [];
    const services = {
      db: async () => poolDb(pool),
      egress: { request: () => Promise.reject(new Error("unused")) },
      smtp: { send: async (_q: unknown, req: unknown) => (sent.push(req), { messageId: "pg-1" }) },
      keyring: () => K1,
    };
    const ctx = (stepId: string): ConnectorContext => ({
      runId: "run-pg",
      workflowId: "wf-pg",
      runStartedAt: new Date(),
      stepId,
      stepKey: "mail",
      attempt: 1,
      test: false,
      log: { info: () => undefined, warn: () => undefined },
      signal: new AbortController().signal,
      ...servicesFor(services, { connector: "email.send", runId: "run-pg", stepId }),
    });
    const input = EMAIL_SEND.input.parse({ credential: cred.id, to: ["ada@example.com"], subject: "s", body: "b" });
    expect(await EMAIL_SEND.run(ctx("step-0"), input)).toEqual({ messageId: "pg-1" });
    expect(await EMAIL_SEND.run(ctx("step-0"), input)).toEqual({ messageId: "pg-1" });
    expect((await pool.query("SELECT count(*)::int AS n FROM email_sends")).rows[0].n).toBe(1);
    await pool.query(
      `INSERT INTO email_sends (step_id, run_id, workflow_id)
       SELECT 'filler-' || g, 'run-pg', 'wf-pg' FROM generate_series(1, $1::int) g`,
      [EMAIL_LIMIT_PER_WORKFLOW - 1],
    );
    const refused = await EMAIL_SEND.run(ctx("step-over"), input).catch((e: ConnectorError) => e);
    expect(refused).toMatchObject({ code: "rate_limited", retryable: false });
    await pool.query("UPDATE email_sends SET created_at = now() - interval '25 hours'");
    expect(await EMAIL_SEND.run(ctx("step-later"), input)).toEqual({ messageId: "pg-1" });
    expect(sent).toHaveLength(3);
  });
});
