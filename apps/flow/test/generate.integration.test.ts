/**
 * Generating a draft from an issue (#283) on a REAL Postgres: migration 7 (the gitlab-token kind, the
 * ai_generation setting, generated_drafts, ai_generations), and lib/generate/service.ts: the admin
 * switch (off by default), Pause all, the provider cool-down, the per-person limits and the daily token
 * cap, the token a private issue is read with, and what the builder shows afterwards.
 *
 * Needs FLOW_TEST_ADMIN_URL (or EVENTS_TEST_ADMIN_URL): a superuser URL on a DEV Postgres. Skipped
 * without it. It uses a throwaway database, dropped afterwards.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keyringFromEnv, type Keyring } from "../lib/credentials/cipher";
import { createCredential } from "../lib/credentials/store";
import {
  availability,
  checkLimits,
  COOL_DOWN_FAILURES,
  generatedInfo,
  generatedKey,
  issuePageUrl,
  issueToken,
  PER_DAY,
  PER_HOUR,
  recordGeneration,
} from "../lib/generate/service";
import { migrate } from "../lib/migrations";
import { setAiGeneration, setPausedAll } from "../lib/settings";
import { KEY } from "../lib/workflow/schema";

const ADMIN_URL = process.env.FLOW_TEST_ADMIN_URL ?? process.env.EVENTS_TEST_ADMIN_URL;
const dbName = `flow_generate_test_${Date.now().toString(36)}`;
const KEYED = { FLOW_AI_API_KEY: "test-key" };

function keyring(): Keyring {
  const s = keyringFromEnv({ FLOW_CREDENTIALS_KEY: randomBytes(32).toString("base64") });
  if (!s.ok) throw new Error(s.reason);
  return s.keyring;
}

describe.skipIf(!ADMIN_URL)("generating a draft from an issue on Postgres (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString() });
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

  beforeEach(async () => {
    await pool.query("DELETE FROM ai_generations");
    await pool.query("DELETE FROM settings");
  });

  it("is off until an admin turns it on; then needs a key; Pause all stops it", async () => {
    expect(await availability(pool, KEYED)).toEqual({ ok: false, reason: "switch_off" });
    await setAiGeneration(pool, true, "admin");
    expect(await availability(pool, {})).toEqual({ ok: false, reason: "not_configured" });
    expect(await availability(pool, KEYED)).toEqual({ ok: true });
    await setPausedAll(pool, true, "admin");
    expect(await availability(pool, KEYED)).toEqual({ ok: false, reason: "paused" });
    await setPausedAll(pool, false, "admin");
    await setAiGeneration(pool, false, "admin");
    expect(await availability(pool, KEYED)).toEqual({ ok: false, reason: "switch_off" });
  });

  it("cools down after the provider failed several times in a row, and recovers after a success", async () => {
    await setAiGeneration(pool, true, "admin");
    for (let i = 0; i < COOL_DOWN_FAILURES; i++)
      await recordGeneration(pool, { subject: "u", outcome: i % 2 ? "ai_timeout" : "ai_unavailable" });
    expect(await availability(pool, KEYED)).toEqual({ ok: false, reason: "cooling_down" });
    // A failure that isn't the provider's (an invalid answer) doesn't count.
    await recordGeneration(pool, { subject: "u", outcome: "invalid_ai_answer" });
    expect(await availability(pool, KEYED)).toEqual({ ok: true });
    // Old failures don't count either.
    await pool.query("DELETE FROM ai_generations");
    for (let i = 0; i < COOL_DOWN_FAILURES; i++)
      await pool.query(
        "INSERT INTO ai_generations (id, subject, outcome, created_at) VALUES ($1, 'u', 'ai_unavailable', now() - interval '10 minutes')",
        [`old-${i}`],
      );
    expect(await availability(pool, KEYED)).toEqual({ ok: true });
  });

  it("limits each person per hour and per day", async () => {
    for (let i = 0; i < PER_HOUR; i++) await recordGeneration(pool, { subject: "alice", outcome: "ok" });
    expect(await checkLimits(pool, "alice")).toEqual({ ok: false, reason: "rate_limited" });
    expect(await checkLimits(pool, "bob")).toEqual({ ok: true });

    await pool.query("DELETE FROM ai_generations");
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // Earlier today, over an hour ago: they count for the day, not the hour.
    const earlier = new Date(Math.max(dayStart.getTime(), now.getTime() - 2 * 60 * 60_000));
    for (let i = 0; i < PER_DAY; i++)
      await pool.query("INSERT INTO ai_generations (id, subject, outcome, created_at) VALUES ($1, 'alice', 'ok', $2)", [
        `d-${i}`,
        earlier,
      ]);
    expect(await checkLimits(pool, "alice", {}, now)).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("stops everyone once the day's tokens reach the cap", async () => {
    await recordGeneration(pool, {
      subject: "alice",
      outcome: "ok",
      model: "claude-opus-5-5",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    expect(await checkLimits(pool, "bob", { FLOW_AI_DAILY_TOKEN_CAP: "1001" })).toEqual({ ok: true });
    expect(await checkLimits(pool, "bob", { FLOW_AI_DAILY_TOKEN_CAP: "1000" })).toEqual({
      ok: false,
      reason: "daily_cap",
    });
    const row = (await pool.query("SELECT * FROM ai_generations")).rows[0];
    expect(Object.keys(row).sort()).toEqual(
      ["created_at", "id", "input_tokens", "model", "outcome", "output_tokens", "subject"].sort(),
    );
  });

  it("reads a private issue only with a token of the host's kind that lists the repository", async () => {
    const K = keyring();
    const gh = await createCredential(
      pool,
      { kind: "github-token", name: "GH read", meta: { repos: ["acme/shop"] }, secret: { token: "gh-secret" } },
      "admin",
      K,
    );
    const gl = await createCredential(
      pool,
      {
        kind: "gitlab-token",
        name: "GL read",
        meta: { projects: ["group/sub/project"] },
        secret: { token: "gl-secret" },
      },
      "admin",
      K,
    );
    if (!gh.ok || !gl.ok) throw new Error("credentials");
    const github = { host: "github" as const, owner: "Acme", repo: "Shop", number: 1 };
    const gitlab = { host: "gitlab" as const, project: "group/sub/project", number: 2 };

    expect(await issueToken(pool, "", github, K)).toEqual({ ok: true });
    expect(await issueToken(pool, gh.id, github, K)).toEqual({ ok: true, token: "gh-secret" });
    expect(await issueToken(pool, gl.id, gitlab, K)).toEqual({ ok: true, token: "gl-secret" });
    expect(await issueToken(pool, gh.id, { ...github, repo: "other" }, K)).toEqual({
      ok: false,
      error: "credential_not_for_repo",
    });
    expect(await issueToken(pool, gl.id, github, K)).toEqual({ ok: false, error: "credential_wrong_kind" });
    expect(await issueToken(pool, "01JAAAAAAAAAAAAAAAAAAAAAAA", github, K)).toEqual({
      ok: false,
      error: "credential_not_found",
    });
    expect(await issueToken(pool, gh.id, github, undefined)).toEqual({ ok: false, error: "credentials_unavailable" });
  });

  it("keeps the draft's notes and the issue's ids for the builder, and drops them with the workflow", async () => {
    await pool.query("INSERT INTO workflows (id, key, name) VALUES ('w1', 'gen-shop-42-abc123', 'Orders')");
    await pool.query(
      `INSERT INTO generated_drafts (workflow_id, source_host, source_repo, source_number, summary, trigger_note, notes, model, created_by)
       VALUES ('w1', 'github', 'acme/shop', 42, 'S', 'T', $1, 'claude-opus-5-5', 'alice')`,
      [JSON.stringify({ approve: "A manager decides." })],
    );
    const info = await generatedInfo(pool, "gen-shop-42-abc123");
    expect(info).toEqual({
      source: { host: "github", repo: "acme/shop", number: 42 },
      summary: "S",
      triggerNote: "T",
      notes: { approve: "A manager decides." },
      model: "claude-opus-5-5",
    });
    expect(issuePageUrl(info!.source)).toBe("https://github.com/acme/shop/issues/42");
    expect(await generatedInfo(pool, "nothing")).toBeNull();
    await expect(
      pool.query(
        `INSERT INTO generated_drafts (workflow_id, source_host, source_repo, source_number, summary, trigger_note, model, created_by)
         VALUES ('w1', 'bitbucket', 'a/b', 1, '', '', 'm', 'x')`,
      ),
    ).rejects.toThrow();
    await pool.query("DELETE FROM workflows WHERE id = 'w1'");
    expect((await pool.query("SELECT count(*)::int AS n FROM generated_drafts")).rows[0].n).toBe(0);
  });

  it("the new workflow's key comes from the issue's ids, kebab-case and at most 64 characters", () => {
    for (const ref of [
      { host: "github" as const, owner: "a", repo: "Shop.Web_App", number: 42 },
      { host: "github" as const, owner: "a", repo: "9lives", number: 1 },
      { host: "github" as const, owner: "a", repo: "...x".padEnd(100, "y"), number: 1234567890 },
      { host: "gitlab" as const, project: "g/sub/my-project", number: 7 },
      { host: "github" as const, owner: "a", repo: "___", number: 3 },
    ]) {
      const key = generatedKey(ref);
      expect(key).toMatch(KEY);
      expect(key.length).toBeLessThanOrEqual(64);
      expect(key.startsWith("gen-")).toBe(true);
    }
    expect(generatedKey({ host: "gitlab", project: "g/sub/my-project", number: 7 })).toMatch(
      /^gen-my-project-7-[a-z0-9]{6}$/,
    );
    expect(generatedKey({ host: "github", owner: "a", repo: "___", number: 3 })).toMatch(/^gen-issue-3-/);
  });
});
