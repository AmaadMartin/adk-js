# Session migration

`migrateFromSqlalchemyPickle` copies an ADK sessions database from the v0
pickle schema into the v1 JSON schema that `DatabaseSessionService` reads.
Reach for it once, when you hold a database an older adk-python release wrote
and you want to open it from adk-js.

## Introduction

The v0 schema spread each event across typed columns and stored its `actions`
as a Python pickle. The v1 schema stores one `event_data` JSON column per
event, and records `schema_version = "1"` in an `adk_internal_metadata` table.
`DatabaseSessionService` reads v1 only; pointed at a v0 database it refuses to
write, because the two layouts disagree about the `events` table.

Two things follow from the pickle. First, adk-js cannot write one, so the
migration is one-way: it reads v0 and produces v1, and there is no route back.
Second, a pickle is executable by design — Python's own loader can be made to
call any function the payload names. The bytes in your `events.actions` column
are input, so this port decodes them with a restricted reader. The reader is a
stack machine that resolves a class name to a plain record and calls nothing.
An unresolvable class is an error, not a dynamic lookup.

The migration writes a second database and never touches the source. That
matters more than it sounds: creating the v1 tables over a legacy database
would add an `event_data` column to its `events` table and destroy the evidence
that it is a v0 database at all. Keep the source until you have checked the
result.

## Get started

```ts
import {migrateFromSqlalchemyPickle} from '@google/adk/sessions/migration';

const summary = await migrateFromSqlalchemyPickle({
  sourceDbUrl: 'postgresql+asyncpg://user:pw@host:5432/legacy',
  destDbUrl: 'postgresql://user:pw@host:5432/migrated',
});
// summary => {appStates: 3, userStates: 12, sessions: 240, events: 9861, skippedEvents: 0}
```

The same run from the command line:

```bash
node node_modules/@google/adk/dist/esm/sessions/migration/cli.js \
  --source_db_url "sqlite:////data/legacy.db" \
  --dest_db_url   "sqlite:////data/migrated.db"
```

Then open the result the way you normally would:

```ts
import {DatabaseSessionService} from '@google/adk/sessions/database';

const service = new DatabaseSessionService('sqlite:///data/migrated.db');
await service.init();
const session = await service.getSession({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
});
```

## Connection URLs

Both URLs accept the SQLAlchemy form an adk-python configuration already holds.
The `+driver` suffix names a Python driver and has no counterpart here, so it
is dropped: `postgresql+asyncpg://host/db` and `postgresql://host/db` reach the
same database. Every URL a log line names is masked first, so a password never
reaches your log files.

The destination needs the MikroORM driver for its scheme installed, the same
way `DatabaseSessionService` does — `@mikro-orm/postgresql`, `@mikro-orm/mysql`,
`@mikro-orm/mariadb`, `@mikro-orm/mssql` or `@mikro-orm/sqlite`.

A sqlite URL takes the file path verbatim after `sqlite://`, so SQLAlchemy's
absolute form works unchanged: `sqlite:////data/legacy.db` opens
`/data/legacy.db`. A relative path needs two slashes rather than three —
`sqlite://./legacy.db` — because `sqlite:///./legacy.db` names `/legacy.db` at
the filesystem root. Use `sqlite://:memory:` for an in-memory database.

## What it guarantees

- The source is read-only for the whole run. Only `SELECT` statements reach it.
- The destination is written inside one transaction. A failure part-way leaves
  no partial copy, and the destination is stamped `schema_version = "1"`.
- A destination that already holds a different `schema_version` is refused
  rather than mixed.
- An event row that cannot be converted is logged, counted in `skippedEvents`,
  and left behind; the rest of the migration continues. The run reports the
  count, so a non-zero `skippedEvents` is your signal to look at the log before
  you delete the source.
- Re-running against the same destination overwrites the rows it already
  copied, so an interrupted migration can simply be run again.

## When `allowUnsafeUnpickling` is warranted

By default the reader resolves only the classes an `EventActions` can hold:
the builtin containers, the stdlib data types a `state_delta` carries, and the
ADK and `google.genai` model classes. Anything else raises `UnpicklingError`,
the event's actions become empty, and the row still migrates.

`allowUnsafeUnpickling: true` widens the allowlist to every class name. It does
not enable code execution — there is nothing in this reader that could execute
a payload — so an admitted class still yields an inert record. Use it when a
source database you trust holds a class the default set refuses, and you would
rather have the field than the refusal.

```ts
await migrateFromSqlalchemyPickle({
  sourceDbUrl,
  destDbUrl,
  allowUnsafeUnpickling: true,
});
```

## Differences from adk-python

- **`event_data.timestamp` is in milliseconds.** adk-python writes epoch
  seconds. adk-js `Event.timestamp` is `Date.now()`, and
  `DatabaseSessionService` reads it back with `new Date(event.timestamp)`, so
  this migration writes what adk-js reads. A database shared between the two
  SDKs will disagree on this field.
- **The unsafe flag differs in kind.** adk-python's
  `--allow_unsafe_unpickling` hands the payload to Python's real unpickler,
  which can execute arbitrary code. Here it only widens which class names
  resolve.
- **The allowlist is prefix-based.** adk-python derives its allowed set by
  walking Pydantic annotations at runtime. This port admits any class under
  `google.adk.`, `google.genai.`, `fastapi.openapi.models` or `pydantic`, which
  is broader, and safe because resolving a name only builds a plain record.
- **`longRunningToolIds` is an array.** adk-python models it as a set, so the
  migration deduplicates the ids.
