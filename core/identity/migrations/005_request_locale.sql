-- The language the person used when asking for access (@asafarim/locale: en, nl, fr or de), so the e-mail that
-- tells them the decision is in that language. Null for requests from before: those get English.
ALTER TABLE connection_requests ADD COLUMN locale text CHECK (locale IS NULL OR locale IN ('en', 'nl', 'fr', 'de'));
