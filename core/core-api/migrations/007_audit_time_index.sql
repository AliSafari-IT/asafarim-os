-- The Admin console's audit filters and overview read the log by time (since/until, the last N days)
-- and by action, across every app: audit_events_app (app_id, at) can't serve those.
CREATE INDEX audit_events_at ON audit_events (at DESC);
CREATE INDEX audit_events_action ON audit_events (action, at DESC);
