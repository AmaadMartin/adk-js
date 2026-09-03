# DatabaseSessionService

`DatabaseSessionService` stores sessions, events and state in a SQL database
through MikroORM. Reach for it when a conversation has to outlive the process,
or when several processes share one conversation.

## Introduction

`InMemorySessionService` keeps everything in process dictionaries, so a restart
loses every conversation and a second worker sees none of the first worker's
sessions. `DatabaseSessionService` implements the same `BaseSessionService`
interface over PostgreSQL, MySQL, MariaDB, MSSQL or SQLite, so you swap the
service and leave the agent code alone.

The service owns four tables — `sessions`, `events`, `app_states` and
`user_states` — plus an `adk_internal_metadata` table that records the schema
version. It creates them on first use and never drops a column, so pointing it
at an existing database is safe.

The SQL driver is an optional peer dependency. Install the one your backend
needs (`@mikro-orm/postgresql`, `@mikro-orm/mysql`, `@mikro-orm/mariadb`,
`@mikro-orm/mssql` or `@mikro-orm/sqlite`) alongside `@google/adk`; a missing
one produces an error naming the package and the install command.

## Get started

```ts
import {createEvent, DatabaseSessionService} from '@google/adk';

const service = new DatabaseSessionService('sqlite://./sessions.db');

const session = await service.createSession({
  appName: 'hello-world',
  userId: 'user-123',
  state: {locale: 'en-US'},
});

await service.appendEvent({
  session,
  event: createEvent({author: 'user', timestamp: Date.now()}),
});

const loaded = await service.getSession({
  appName: 'hello-world',
  userId: 'user-123',
  sessionId: session.id,
});

console.log(loaded?.events.length, loaded?.state);
await service.close();
```

A session is identified by the triple `(appName, userId, sessionId)`, so all
three are required on every read. `close()` releases the connections the
service opened; a short-lived process that skips it may not exit, because the
SQLite driver holds an open handle on the event loop.

## Connection strings

The scheme selects the backend: `postgres`, `postgresql`, `mysql`, `mariadb`,
`mssql` or `sqlite`. `sqlite://:memory:` opens an in-memory database, and any
other `sqlite://` URI is a file path.

A SQLAlchemy-style scheme that also names a driver, such as
`postgresql+asyncpg://`, is rejected with a message telling you to drop the
suffix — adk-js selects its own driver. Every error that mentions a URL masks
its password first.

You can pass a MikroORM options object or an already-initialized `MikroORM`
instance instead of a string. The service closes only an instance it created
itself.

## Engine options

A second constructor argument overrides the options derived from the URL. It is
merged last, so it wins:

```ts
const service = new DatabaseSessionService(
  'postgres://user:pw@localhost:5432/adk',
  {pool: {min: 2, max: 8}},
);
```

Two defaults are worth knowing.

**Connection checks.** On every backend except SQLite, the pool checks a
connection is alive before handing it out, which costs one round trip per
checkout. This is what stops a connection that a server or firewall closed
overnight from failing the next query. Passing your own `pool` object replaces
the default and removes the check.

**A single SQLite in-memory connection.** Each connection to
`sqlite://:memory:` opens its own empty database, so the pool is capped at one
connection. A file-backed SQLite URI keeps the driver's default pool.

## Reading from a replica

`getSession`, `listSessions` and `getUserState` ask MikroORM for a read
connection. With no replica configured MikroORM uses the primary, so this
changes nothing until you add one:

```ts
import {MikroORM} from '@mikro-orm/core';
import {PostgreSqlDriver} from '@mikro-orm/postgresql';
import {DatabaseSessionService} from '@google/adk';

const orm = await MikroORM.init({
  clientUrl: 'postgres://user:pw@primary:5432/adk',
  driver: PostgreSqlDriver,
  replicas: [{clientUrl: 'postgres://user:pw@replica:5432/adk'}],
});
const service = new DatabaseSessionService(orm);
```

`createSession`, `appendEvent` and `deleteSession` stay on the primary.

## Concurrent appends

`appendEvent` serializes appends for one session within the process, and
rejects a write from a session object that storage has moved past with
`StaleSessionError`. Reload the session and append again when you see it.

On MySQL, MariaDB and PostgreSQL the write also takes a row-level lock on the
session row, and on the app-state or user-state row when the event carries a
delta for that scope. SQLite and MSSQL take no such lock: SQLite ignores
`FOR UPDATE`, and on MSSQL it would become a table hint.

## Opening a legacy database

A database written by adk-python 1.19.0 through 1.21.0 uses an older schema
that spreads each event over flat columns and stores its `EventActions` as a
Python pickle. `DatabaseSessionService` detects that schema and opens it
read-only.

`getSession`, `listSessions` and `getUserState` work. Every event comes back
with its content, author, branch and metadata intact but with **empty
actions**, because only Python can decode the pickle, and the service logs one
warning saying so. `createSession`, `appendEvent` and `deleteSession` throw.

Migrate the database with adk-python's `adk migrate session` command to get a
writable one. Until you do, the service creates no table and writes no schema
version, so the database stays exactly as adk-python left it.

This only works when the service opens the database itself. MikroORM fixes an
instance's entity set when the instance is created, so a `MikroORM` you built
and passed in cannot be switched to the legacy entities; the service throws and
says so.
