# DatabaseSessionService

`DatabaseSessionService` stores sessions and events in a SQL database through
MikroORM. Reach for it when a conversation must outlive the process, when
several server instances share one conversation store, or when adk-js and
adk-python read the same database.

## Introduction

`InMemorySessionService` keeps everything in a process-local map, so a restart
loses every conversation and a second instance sees none of the first one's
work. `DatabaseSessionService` implements the same `BaseSessionService`
interface against Postgres, MySQL, MariaDB, SQL Server, or sqlite, so you swap
the service and leave the agent code alone.

The table layout matches adk-python's v1 schema column for column. A team can
run both SDKs against one database: adk-js reads the sessions adk-python wrote,
orders lists the same way, and answers `afterTimestamp` queries with the same
rows. A database still on adk-python's older v0 layout is readable too, but only
readable — see [Legacy databases](#legacy-databases).

The database driver is an optional peer dependency, so installing `@google/adk`
does not pull in a SQL client you never use. Install the one your URL names, for
example `npm install @mikro-orm/sqlite`.

## Get started

```ts
import {createEvent, DatabaseSessionService} from '@google/adk';

const sessionService = new DatabaseSessionService('sqlite://./sessions.db');

const session = await sessionService.createSession({
  appName: 'hello-world',
  userId: 'user-123',
  state: {locale: 'en-US'},
});

await sessionService.appendEvent({
  session,
  event: createEvent({author: 'user', timestamp: Date.now()}),
});

const loaded = await sessionService.getSession({
  appName: 'hello-world',
  userId: 'user-123',
  sessionId: session.id,
});

// Release the connection when the process is done with it.
await sessionService.close();
```

`init()` runs on the first call, creates the tables if they are absent, and
records the schema version. You do not have to call it yourself.

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
const sessionService = new DatabaseSessionService(
  'postgresql://user:password@localhost:5432/adk',
  {pool: {min: 2, max: 20}},
);
```

You can also hand over a MikroORM instance you built yourself. The service uses
it and never closes it, because you own it. Register
`SESSION_STORAGE_ENTITIES`: the service cannot change the entity set of an
instance it did not open.

```ts
import {DatabaseSessionService, SESSION_STORAGE_ENTITIES} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {PostgreSqlDriver} from '@mikro-orm/postgresql';

const orm = await MikroORM.init({
  clientUrl: 'postgresql://user:password@localhost:5432/adk',
  driver: PostgreSqlDriver,
  entities: SESSION_STORAGE_ENTITIES,
});

const sessionService = new DatabaseSessionService(orm);
await sessionService.close(); // The ORM stays open.
await orm.close();
```

Options cannot be combined with an instance: they could never take effect, so
the constructor throws instead of dropping them.

## Reading a session

`getSession` takes a config that trims the event history it loads:

```ts
const recent = await sessionService.getSession({
  appName: 'hello-world',
  userId: 'user-123',
  sessionId: session.id,
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

## Legacy databases

adk-python's v0 schema spread an event across typed columns and stored its
actions as a Python pickle. adk-js detects such a database and opens it with the
legacy entity set, so `getSession`, `listSessions` and `deleteSession` work. Two
limits apply:

- **Event actions come back empty.** No TypeScript reader can decode a Python
  pickle. The service logs a warning once per instance.
- **Writes are refused.** `createSession` and `appendEvent` throw, because a
  write from adk-js would produce an `actions` value adk-python cannot read
  back. Migrate the database with adk-python's `adk migrate session` command
  first.

A legacy database is never altered: adk-js does not create its tables, add the
v1 `event_data` column, or write a schema-version row. Detection needs the
service to open its own connection, so a legacy database cannot be used with a
MikroORM instance you built.
