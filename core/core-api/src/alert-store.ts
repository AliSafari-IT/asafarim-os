/**
 * Admin's alert history in Postgres (`alert_events`, migration 005), so the Status page's "Recent
 * alerts" survive a core-api restart. The status alerter (alerts.ts) saves each round's transitions
 * here best effort and loads the newest ones once at start.
 *
 * A row holds only what an AlertRecord holds (time, kind, app id and name, live/ready, error class and
 * detail), never a URL, upstream or header. Rows older than `retentionDays` (default 90) are deleted
 * when a round is saved.
 */
import type pg from "pg";
import type { AlertRecord, AlertStore } from "./alerts.ts";

const DEFAULT_RETENTION_DAYS = 90;

interface Row {
  at: Date;
  kind: AlertRecord["kind"];
  app_id: string;
  name: string;
  live: AlertRecord["live"];
  ready: AlertRecord["ready"];
  error: string | null;
  detail: string | null;
}

export function createPgAlertStore(pool: Pick<pg.Pool, "query">, opts: { retentionDays?: number } = {}): AlertStore {
  const retentionDays = Math.max(1, Math.floor(opts.retentionDays ?? DEFAULT_RETENTION_DAYS));
  return {
    async save(records) {
      if (records.length === 0) return;
      // One statement for the round, in the round's own order, so the ids keep that order.
      await pool.query(
        `INSERT INTO alert_events (at, kind, app_id, name, live, ready, error, detail)
         SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                              $7::text[], $8::text[])`,
        [
          records.map((r) => r.at),
          records.map((r) => r.kind),
          records.map((r) => r.id),
          records.map((r) => r.name),
          records.map((r) => r.live),
          records.map((r) => r.ready),
          records.map((r) => r.error ?? null),
          records.map((r) => r.detail ?? null),
        ],
      );
      await pool.query("DELETE FROM alert_events WHERE at < now() - make_interval(days => $1)", [retentionDays]);
    },
    async recent(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      // Newest round first; within a round, the order it was saved in (as the in-memory history).
      const { rows } = await pool.query<Row>(
        `SELECT at, kind, app_id, name, live, ready, error, detail FROM alert_events
         ORDER BY at DESC, id ASC LIMIT $1`,
        [n],
      );
      return rows.map((r) => ({
        at: r.at.toISOString(),
        kind: r.kind,
        id: r.app_id,
        name: r.name,
        live: r.live,
        ready: r.ready,
        ...(r.error ? { error: r.error } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
      }));
    },
  };
}
