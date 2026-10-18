-- A "cleared" row in the alert log (ADR 0001 Addendum M, the os#161 known limit). The status alerter
-- (alerts.ts) saves one when an app it had alerted on as down stops being polled (deactivated or
-- removed) before it recovered. It is not a transition anyone is told about: Admin's history and the
-- webhook never show it. It only ends the app's open "down", so a restarted core-api doesn't restore
-- that app as already alerted and later send a "recovered" for an outage nobody saw end.
ALTER TABLE alert_events
  DROP CONSTRAINT alert_events_kind_check,
  ADD CONSTRAINT alert_events_kind_check CHECK (kind IN ('down', 'recovered', 'cleared'));
