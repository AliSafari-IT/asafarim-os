-- Admin's alert history, kept across restarts (ADR 0001 Addendum M follow-up). One row per down or
-- recovered transition the status alerter saw (alerts.ts): the same fields the in-memory history and a
-- webhook message carry, never a URL, upstream or header. Not tied to `apps`: core-api's own entry is
-- not an app, and the log outlives an app's removal. core-api prunes rows older than 90 days.
CREATE TABLE alert_events (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('down', 'recovered')),
  app_id  text NOT NULL,
  name    text NOT NULL,
  live    text NOT NULL CHECK (live IN ('up', 'down', 'unknown')),
  ready   text NOT NULL CHECK (ready IN ('up', 'down', 'unknown')),
  error   text,
  detail  text
);
CREATE INDEX alert_events_at ON alert_events (at DESC, id);
