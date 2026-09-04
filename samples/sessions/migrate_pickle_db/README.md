# Migrating a pickle sessions database

A **v0** sessions database is one an older adk-python wrote: each event is
spread over its own columns and its `actions` are a Python pickle blob.
`DatabaseSessionService` refuses to write to that layout. `migrate()` copies it
into the **v1** layout, where the whole event is one JSON column.

`migrate.ts` writes a small v0 database of its own in a temporary directory,
migrates it, and reads the result back through `DatabaseSessionService`. It
runs offline and needs no API key:

```bash
npx tsx samples/sessions/migrate_pickle_db/migrate.ts
```

It prints the recovered session state and the state delta of the event whose
`actions` were pickled, which is the part a plain SQL copy cannot move.

To migrate a real database, point the script at one instead. The two URLs
accept the schemes `DatabaseSessionService` accepts, and SQLAlchemy's
`dialect+driver://` spelling:

```bash
ADK_SOURCE_DB_URL='sqlite://./legacy_sessions.db' \
ADK_DEST_DB_URL='sqlite://./sessions.db' \
  npx tsx samples/sessions/migrate_pickle_db/migrate.ts
```

The source is only read from, so the original database is left as it was.

For the allowlist that guards the pickled column, and what
`allowUnsafeUnpickling` does, see
[the guide](../../../docs/guides/sessions/pickle_migration/index.md).
