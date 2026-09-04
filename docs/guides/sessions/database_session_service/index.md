# DatabaseSessionService

`DatabaseSessionService` stores sessions, events and state in a SQL database
through MikroORM. Reach for it when your agent runs in more than one process,
or when a conversation has to survive a restart.

## Introduction

`InMemorySessionService` loses everything when the process exits, and
`VertexAiSessionService` binds you to a managed backend. `DatabaseSessionService`
sits between them: you own the database, and any SQL backend MikroORM drives
will do.

The service opens the database itself from a connection URI, and how it opens
it is not neutral. A sqlite database held in memory lives inside its
connection, so a pool wider than one connection hands out connections onto
separate empty databases. sqlite reads `foreign_keys` per connection and
defaults it off, and MikroORM's driver sets the pragma only on the connection
it opens first. A pooled connection that a firewall dropped surfaces the
driver's raw socket error instead of being replaced. The service configures
each of these per backend, so you do not have to.

The database driver is an optional peer dependency. Install the one your URI
names: `@mikro-orm/sqlite`, `@mikro-orm/postgresql`, `@mikro-orm/mysql`,
`@mikro-orm/mariadb`, or `@mikro-orm/mssql`.

## Get started

```ts
import {DatabaseSessionService} from '@google/adk';

await using service = new DatabaseSessionService('sqlite://./sessions.db');

const session = await service.createSession({
  appName: 'my-app',
  userId: 'user-1',
});

const restored = await service.getSession({
  appName: 'my-app',
  userId: 'user-1',
  sessionId: session.id,
});
```

`await using` releases the pool at the end of the block. Without it, call
`close()` yourself:

```ts
const service = new DatabaseSessionService('sqlite://./sessions.db');
try {
  await service.createSession({appName: 'my-app', userId: 'user-1'});
} finally {
  await service.close();
}
```

`close()` is safe before the first query and safe to call twice. A later call
to any method reopens the database.

## Connection URIs

| URI                                   | Backend                |
| ------------------------------------- | ---------------------- |
| `sqlite://:memory:`                   | sqlite, held in memory |
| `sqlite:///path/to/sessions.db`       | sqlite, on disk        |
| `postgres://user:pass@host:5432/db`   | PostgreSQL             |
| `postgresql://user:pass@host:5432/db` | PostgreSQL             |
| `mysql://user:pass@host:3306/db`      | MySQL                  |
| `mariadb://user:pass@host:3306/db`    | MariaDB                |
| `mssql://user:pass@host:1433/db`      | SQL Server             |

A URI carrying a SQLAlchemy-style driver suffix is rejected, because adk-js
selects its own driver:

```ts
new DatabaseSessionService('postgresql+asyncpg://user:pass@db:5432/app');
// Error: Database URL 'postgresql+asyncpg://user:***@db:5432/app' names the
//   'asyncpg' driver in its scheme. adk-js selects its own driver, so use a
//   'postgresql://' URL instead.
```

Every error that names a URL names it with the password masked, so a
connection string cannot reach a log file or an error tracker.

## Engine settings

The service derives these from the URI:

| Backend             | Setting                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| sqlite, `:memory:`  | The pool holds one connection, so the database is not recreated per connection. |
| sqlite, any         | `PRAGMA foreign_keys = ON` runs on every connection the pool opens.             |
| every other backend | A `select 1` probe checks a pooled connection before it is handed out.          |

Pass a second argument to replace any of them:

```ts
const service = new DatabaseSessionService(
  'postgres://user:pass@host:5432/db',
  {pool: {min: 2, max: 20}},
);
```

```ts
// Turn the liveness probe off.
const service = new DatabaseSessionService(
  'postgres://user:pass@host:5432/db',
  {driverOptions: {}},
);
```

Overrides apply to a URI only. An options object already carries its own
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
