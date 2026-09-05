# DatabaseSessionService

`DatabaseSessionService` stores sessions, events and state in a SQL database
through MikroORM. Reach for it when a conversation must survive a restart, when
more than one process appends to the same conversation, or when adk-js and
adk-python read the same database.

## Introduction

`InMemorySessionService` keeps everything in process maps. Nothing survives a
restart, and two workers never see each other's turns.
`DatabaseSessionService` moves the same data into SQLite, PostgreSQL, MySQL,
MariaDB or SQL Server, so several processes can share one conversation.

Sharing a conversation creates a problem the in-memory service does not have.
Two turns can load the same `Session` object and both append to it. The second
append would overwrite the first turn's history. This service detects that: it
stamps every session it returns with the storage revision it was loaded at, and
`appendEvent` rejects a write whose revision no longer matches.

The table layout matches adk-python's v1 schema column for column. A team can
run both SDKs against one database: adk-js reads the sessions adk-python wrote,
orders lists the same way, and answers `afterTimestamp` queries with the same
rows. A database still on adk-python's older v0 layout is read and written too
— see [Legacy databases](#legacy-databases).

The driver package for your database is an optional peer dependency, so
installing `@google/adk` does not pull in a SQL client you never use. Install
the one your URL names, for example `npm install @mikro-orm/sqlite`.

## Get started

```ts
import {DatabaseSessionService, createEvent} from '@google/adk';

const service = new DatabaseSessionService('sqlite://./sessions.db');
try {
  const session = await service.createSession({
    appName: 'my-app',
    userId: 'u1',
    sessionId: 's1',
  });

  await service.appendEvent({session, event: createEvent({author: 'user'})});
} finally {
  await service.close();
}
```

`await using` releases the pool at the end of the block, so the `finally` is
not needed:

```ts
await using service = new DatabaseSessionService('sqlite://./sessions.db');

const session = await service.createSession({appName: 'my-app', userId: 'u1'});
```

Every method connects on first use, creates the tables if they are absent, and
records the schema version. Call `init()` during startup to pay that cost
upfront instead. It is safe to call twice and safe to call concurrently.

## Connection URLs

The scheme selects the backend and its driver package:

| Scheme                         | Driver package          |
| ------------------------------ | ----------------------- |
| `postgres://`, `postgresql://` | `@mikro-orm/postgresql` |
| `mysql://`                     | `@mikro-orm/mysql`      |
| `mariadb://`                   | `@mikro-orm/mariadb`    |
| `mssql://`                     | `@mikro-orm/mssql`      |
| `sqlite://`                    | `@mikro-orm/sqlite`     |

Use `sqlite://:memory:` for an in-memory database, and `sqlite://<path>` for a
file.

The constructor validates the URL, so a bad one fails immediately rather than on
the first query. Three messages tell the three cases apart, and every one of
them masks the password:

- A string with no scheme: `Invalid database URL format or argument '...'.`
- A scheme naming a backend adk-js cannot open:
  `Unsupported database URI: ...`
- A scheme naming a driver, which is how SQLAlchemy URLs are written:
  `Database URL '...' names the 'asyncpg' driver in its scheme. adk-js selects
its own driver, so use a 'postgresql://' URL instead.`

That last one is the one you hit when you paste an adk-python URL. Drop the
`+asyncpg` or `+psycopg2` suffix and the same URL works.

## Engine options

The service derives MikroORM options from the URL. Two of those defaults exist
to match adk-python's engine setup:

- **sqlite** gets `PRAGMA foreign_keys = ON` on every connection the pool opens.
  Without it the `events -> sessions ON DELETE CASCADE` constraint never fires.
  A `sqlite://:memory:` URL also gets a single-connection pool, because every
  new connection to an in-memory database opens a separate, empty one.
- **Every other backend** gets a `select 1` probe before a pooled connection is
  handed out. A long-lived server whose idle connection a firewall dropped
  reconnects rather than surfacing the driver's socket error. This is
  adk-python's `pool_pre_ping`.

Pass a second argument to replace any derived option:

```ts
const service = new DatabaseSessionService('postgres://localhost/adk', {
  pool: {min: 2, max: 10},
});
```

Both hooks live under `driverOptions`, so replace that option to drop one:

```ts
const service = new DatabaseSessionService('postgres://localhost/adk', {
  driverOptions: {pool: {}}, // no liveness check
});
```

Overrides apply to a URL only. An options object already carries its own
settings, so combining the two is rejected.

## Timestamps and time zones

Every backend the service supports stores a session timestamp in a column that
drops the time zone. The service therefore opens each connection with
`forceUtcTimezone`, so a stored wall clock is UTC rather than the Node
process's local zone. adk-python reaches the same result by stripping `tzinfo`
before it stores.

Two things follow. A session that adk-python wrote resolves to the instant it
meant, even when the reading process runs on another zone. And what
`createSession` writes equals what `getSession` reads back, so a timestamp
comparison cannot fail on the offset alone.

Pass `forceUtcTimezone: false` to keep the local zone instead:

```ts
const service = new DatabaseSessionService('mysql://user:pass@host:3306/db', {
  forceUtcTimezone: false,
});
```

A MySQL, MariaDB or SQL Server database that an earlier version of adk-js wrote
in a non-UTC process holds local wall clocks. Those rows read back shifted by
that process's offset. sqlite and PostgreSQL are unaffected, because MikroORM
already stored an unambiguous value on both.

JavaScript `Date` keeps milliseconds and adk-python keeps microseconds, so a
timestamp adk-python wrote is truncated when adk-js reads it.

## Reads, writes and locking

`getSession` and `listSessions` run on an entity manager that does not flush
outside a transaction, so a read cannot write through it. `createSession`,
`deleteSession` and `appendEvent` run on a separate one.

`appendEvent` takes a row-level write lock on the session row, but only on
MariaDB, MySQL and PostgreSQL. sqlite compiles `SELECT ... FOR UPDATE` away,
and SQL Server turns it into a table hint, so neither is asked for the lock.
An unrecognized backend is not locked either, which is safe everywhere.

## Reading a session

`getSession` takes a config that trims the event history it loads:

```ts
const recent = await service.getSession({
  appName: 'my-app',
  userId: 'u1',
  sessionId: 's1',
  config: {numRecentEvents: 20, afterTimestamp: cutoffMilliseconds},
});
```

- `afterTimestamp` is **inclusive**: an event whose timestamp equals it is
  returned. It is a millisecond value, where adk-python uses seconds.
- `numRecentEvents: 0` returns no events and runs no events query at all, which
  is the cheap way to read a session's state and metadata.
- The filter applies first and the limit second, so you get the newest N events
  from the filtered range.
- Events come back oldest-first. Two events sharing a timestamp keep a stable
  order across reads, because the query breaks the tie on the event id.

## Listing sessions

`listSessions` always returns an ordered list: update time first, then user id,
then session id, all ascending. `order: 'desc'` flips the update-time key only,
so the tie breaks stay ascending. An ordered list is what makes a paginated
sweep safe — an unordered one can repeat or skip a row between pages.

`userId` is a filter, and an empty string is a user id like any other:
`listSessions({appName, userId: ''})` returns the sessions of the user whose id
is empty, not every user's sessions. Omit `userId` to list them all.

## Rejecting a stale write

`appendEvent` throws `StaleSessionError` when storage has moved past the
session you hold:

```ts
import {Event, Session, StaleSessionError} from '@google/adk';

async function appendOrReload(session: Session, event: Event): Promise<void> {
  try {
    await service.appendEvent({session, event});
    return;
  } catch (error: unknown) {
    if (!(error instanceof StaleSessionError)) {
      throw error;
    }
  }

  const fresh = await service.getSession({
    appName: session.appName,
    userId: session.userId,
    sessionId: session.id,
  });
  if (fresh) {
    await service.appendEvent({session: fresh, event});
  }
}
```

Nothing is written when the check fails, so a retry against a freshly loaded
session is safe.

A session you built by hand carries no revision marker. The service then
compares your last event against the newest stored event instead, and only
rejects the write when the two differ.

Within one process, appends for the same `(appName, userId, sessionId)` are
serialized, so two concurrent calls cannot read the same revision and both
write.

## Reading user state

User state is keyed by `(appName, userId)` and is shared by every session that
user has in the app. Read it without a session id:

```ts
const prefs = await service.getUserState({appName: 'my-app', userId: 'u1'});
// => {lang: 'fr'}   raw keys, no `user:` prefix
```

The result is a copy, and it is empty when nothing has been stored. Other
backends may not support this: `BaseSessionService` throws by default, and the
message names `listSessions` plus `getSession` as the fallback.

## Owning the connection

Pass a MikroORM instance you already built when your application owns the
connection pool. The service uses it and never closes it, because you own it.
Register `SESSION_STORAGE_ENTITIES`: the service cannot change the entity set of
an instance it did not open.

```ts
import {DatabaseSessionService, SESSION_STORAGE_ENTITIES} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {PostgreSqlDriver} from '@mikro-orm/postgresql';

const orm = await MikroORM.init({
  clientUrl: 'postgresql://user:password@localhost:5432/adk',
  driver: PostgreSqlDriver,
  entities: SESSION_STORAGE_ENTITIES,
});

const service = new DatabaseSessionService(orm);
await service.close(); // `orm` stays open; the caller closes it.
await orm.close();
```

Options cannot be combined with an instance: they could never take effect, so
the constructor throws instead of dropping them.

`close()` only disposes an ORM this service created. It is safe to call twice,
and safe to call before `init()`. It does not retire the service: a later call
connects again, which is what the adk-python service does too. Note what that
means for `sqlite://:memory:`, whose database lives inside the connection —
reconnecting there opens a new, empty one.

## Legacy databases

adk-python's v0 schema spread an event across typed columns and stored its
actions as a Python pickle. adk-js detects such a database and opens it with the
legacy entity set, so every method works on it: `createSession`, `appendEvent`,
`getSession`, `listSessions` and `deleteSession`.

`appendEvent` writes the `actions` column as a pickle adk-python's restricted
unpickler reads back, and `getSession` decodes one written by either SDK. An
`actions` value that has no Python counterpart — a `Date`, for example — makes
`appendEvent` throw rather than store a blob Python cannot load. A stored blob
that will not decode reads back with empty actions and a warning naming the
event, so one unreadable row does not cost you the session's history.

Migrating to v1 is still the recommendation. The v0 layout is deprecated in
adk-python, and `adk migrate session` moves a database to v1.

adk-js keeps a legacy database on its own layout. Opening one creates a missing
v0 table and a missing `idx_events_app_user_session_ts` index, and nothing else:
no `adk_internal_metadata` table, no v1 `event_data` column, and no
schema-version row. Detection needs the service to open its own connection, so
`init()` throws for a legacy database reached through a MikroORM instance you
built.

## Failure modes

| Condition                                        | Result                           |
| ------------------------------------------------ | -------------------------------- |
| `createSession` with an id that exists           | `AlreadyExistsError`             |
| `appendEvent` on a session storage does not hold | `SessionNotFoundError`           |
| `appendEvent` from a superseded session          | `StaleSessionError`              |
| An app or user state row is missing              | `Error` naming the missing scope |
| A v0 `actions` value with no Python counterpart  | `Error` from `appendEvent`       |
| A legacy v0 database behind a caller-owned ORM   | `Error` from `init()`            |

## Timestamp precision

Every stored timestamp column keeps three fractional digits, so an
`Event.timestamp` survives the round trip to the millisecond. On MySQL and
MariaDB that is the difference between `datetime(3)` and `datetime`, which
holds whole seconds. Millisecond precision is what makes two events one
millisecond apart distinguishable, both to the revision marker and to the
event ordering.

A database created by an earlier release still has the whole-second column,
because table creation runs in safe mode and does not alter an existing one.
The service reads each revision back from storage after it writes, so the
marker describes the stored value and a held session keeps working there. What
that database cannot do is tell two writes in the same second apart, so alter
the columns to `datetime(3)` to get the full guarantee.

## PostgreSQL timestamp columns

Every timestamp column carries no time zone, which is what adk-python declares
for the same table. On PostgreSQL that is `timestamp(6)`. The driver binds and
reads a `Date` as UTC, so the stored instant is the same one you wrote.

An adk-js release before this one declared `timestamptz(6)` on PostgreSQL.
Opening such a database now emits an `ALTER TABLE ... ALTER COLUMN ... TYPE
timestamp(6)`, and PostgreSQL converts each value through the session
`TimeZone`. Run the first open with `SET TimeZone = 'UTC'` so the stored
instants do not shift. A server already on UTC needs nothing.
