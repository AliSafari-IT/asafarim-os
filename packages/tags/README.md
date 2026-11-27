# Reusing the tag catalog

Knowledge uses this server-side PostgreSQL package to create and resolve curated keywords. Each app owns its vocabulary, permissions, and content links. A private Notes tag can have the same spelling as a public Knowledge tag without revealing the tag or its assignments across apps.

To adopt it in Notes:

1. Add the workspace dependency and create the catalog tables in the Notes database. Use Knowledge migration 6 as the schema reference for `tags` and `tag_aliases`. Keep unique canonical slugs and aliases, stable text IDs, and an index on the assignment table’s tag ID. Choose tag kinds appropriate for Notes.
2. Create a `note_tags(note_id, tag_id)` join table with foreign keys and a composite primary key. For personal vocabularies within a shared multi-user database, introduce tenant-scoped keys and queries before adopting this catalog. The current adapter expects one vocabulary per database or schema.
3. Authorize creation in the host app, validate its allowed kinds, and call `insertTag` inside a transaction. Use `resolveTags` for assignments. It resolves canonical slugs and aliases before unambiguous display names and deduplicates IDs.
4. Save assignments and refresh any search index in the same transaction. Build tag pages and suggestions from content the current reader can access. Knowledge uses its published search projection for this purpose.

Tags are descriptive labels. Assignment to a tag grants no access to the underlying content.
