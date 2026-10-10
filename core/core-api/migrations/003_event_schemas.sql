-- The event catalog (P4.2, ADR 0001 §5): the JSON Schema of every type an app publishes, uploaded
-- by the app (signed PUT /registry/v1/apps/<id>/event-schemas) after it registers. Each upload
-- replaces the app's whole set; a registration that stops publishing a type deletes its row.
CREATE TABLE event_schemas (
  app_id       text NOT NULL REFERENCES apps(id),
  event_type   text NOT NULL,
  schema       jsonb NOT NULL,
  -- The app's version when it uploaded this schema.
  app_version  text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, event_type)
);
