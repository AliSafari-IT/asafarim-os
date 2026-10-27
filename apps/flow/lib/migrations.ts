/**
 * Flow's own migrations, in order. Each runs once (recorded in `flow_migrations`), all under one
 * advisory lock so two instances starting at once can't run them twice. Never edit one that has
 * shipped: add the next.
 */
import { INBOX_SQL, OUTBOX_SQL } from "@asafarim/app-sdk/events";

const RUN_STATUSES = "'running', 'waiting', 'succeeded', 'failed', 'skipped', 'rejected', 'cancelled'";
const STEP_STATUSES = "'pending', 'running', 'waiting', 'succeeded', 'failed', 'timed_out', 'skipped'";

export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "workflows, versions, runs, steps, approvals; the outbox and the inbox",
    sql: `
CREATE TABLE workflows (
  id         text PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable: a change to a workflow is a new version. Runs are pinned to the version they started on.
CREATE TABLE workflow_versions (
  id           text PRIMARY KEY,
  workflow_id  text NOT NULL REFERENCES workflows (id),
  version      integer NOT NULL CHECK (version >= 1),
  definition   jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
CREATE FUNCTION flow_workflow_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow_versions are immutable: publish a new version';
END $$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION flow_workflow_versions_immutable();

CREATE TABLE workflow_runs (
  id               text PRIMARY KEY,
  version_id       text NOT NULL REFERENCES workflow_versions (id),
  -- A second guard after the inbox: one run per trigger event.
  trigger_event_id text NOT NULL UNIQUE,
  trigger          jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN (${RUN_STATUSES})),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  error_code       text
);
CREATE INDEX workflow_runs_started ON workflow_runs (started_at DESC);
CREATE INDEX workflow_runs_status ON workflow_runs (status, started_at DESC);
CREATE INDEX workflow_runs_ended ON workflow_runs (ended_at) WHERE ended_at IS NOT NULL;

CREATE TABLE workflow_run_steps (
  id               text PRIMARY KEY,
  -- The order the run reached its steps in.
  seq              bigserial NOT NULL UNIQUE,
  run_id           text NOT NULL REFERENCES workflow_runs (id),
  step_key         text NOT NULL,
  status           text NOT NULL CHECK (status IN (${STEP_STATUSES})),
  request_event_id text,
  outcome_event_id text,
  input            jsonb,
  output           jsonb,
  attempts         integer NOT NULL DEFAULT 0,
  started_at       timestamptz,
  ended_at         timestamptz,
  timeout_at       timestamptz,
  error_code       text,
  error_message    text,
  UNIQUE (run_id, step_key)
);
CREATE INDEX workflow_run_steps_overdue ON workflow_run_steps (timeout_at) WHERE status = 'waiting';

-- Used from PR 4 (the approval step); the table ships now so its migration is in place.
CREATE TABLE approvals (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES workflow_runs (id),
  step_id       text NOT NULL REFERENCES workflow_run_steps (id),
  status        text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  assignee_role text NOT NULL,
  deadline      timestamptz,
  decided_by    text,
  decided_at    timestamptz,
  comment       text,
  edited        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending ON approvals (deadline) WHERE status = 'pending';

${OUTBOX_SQL}
${INBOX_SQL}`,
  },
  {
    version: 2,
    name: "approvals: by run, and one pending approval per step",
    sql: `
CREATE INDEX approvals_run ON approvals (run_id, created_at);
-- A step waits on one approval at a time; a retry after expiry opens a new one.
CREATE UNIQUE INDEX approvals_one_pending ON approvals (step_id) WHERE status = 'pending';`,
  },
];

/** Run the migrations not applied yet, in one transaction under an advisory lock. */
export async function migrate(client: {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<number[]> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('flow.migrations'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS flow_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query("SELECT version FROM flow_migrations")).rows.map((r) => r.version as number),
    );
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query("INSERT INTO flow_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
      applied.push(m.version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
