# DatabaseSessionService: backends, timestamps and the connection

`DatabaseSessionService` stores sessions, events and state in a SQL database
through MikroORM. Reach for it when a conversation must survive a restart, or
when several processes share one conversation. This guide covers the three
things that depend on which backend you point it at: whether it takes a
row-level lock, how it stores a timestamp, and how you give the connection
back.

## Introduction

The service supports sqlite, PostgreSQL, MySQL, MariaDB and SQL Server. They do
not all behave the same way, so the service asks the open connection which
backend it is talking to and adapts.

Two differences matter to a caller. A backend either implements
`SELECT ... FOR UPDATE` or it does not, and the service only requests the lock
where it exists. A backend either keeps the time zone on a datetime column or
drops it, and the service stores UTC on every backend that drops it. Both rules
match `DatabaseSessionService` in adk-python, so a database one SDK writes reads
back correctly in the other.

The third thing is the connection itself. The service opens a pool on the first
call and holds it until you close it. A long-running server wants that. A script
does not: the sqlite driver keeps its file open, so the process does not exit.

## Get started

```ts
import {createEvent, DatabaseSessionService} from '@google/adk';

const service = new DatabaseSessionService('sqlite://./sessions.db');

const session = await service.createSession({
  appName: 'my-app',
  userId: 'user-1',
  state: {greeting: 'hello'},
});
await service.appendEvent({
  session,
  event: createEvent({author: 'user', invocationId: 'invocation-1'}),
});

await service.close();
```

Pass a MikroORM options object instead of a URI when you need driver settings
the URI cannot carry:

```ts
import {DatabaseSessionService} from '@google/adk';
import {SqliteDriver} from '@mikro-orm/sqlite';

const service = new DatabaseSessionService({
  dbName: './sessions.db',
  driver: SqliteDriver,
});
```

## Row-level locking

`appendEvent` reads the session row inside a transaction. On MariaDB, MySQL and
PostgreSQL it takes a write lock on that row, so a concurrent append in another
process waits instead of racing.

sqlite and SQL Server get no lock. sqlite serializes writes at the file level,
and MikroORM would turn the request into a SQL Server table hint that adk-python
never asks for. An unrecognized backend gets no lock either, which is safe
everywhere.

## Timestamps and time zones

Every backend the service supports stores `create_time` and `update_time` in a
column that drops the time zone. The service therefore opens the connection with
MikroORM's `forceUtcTimezone`, so the stored wall clock is UTC rather than the
Node process's local zone. adk-python reaches the same result by stripping
`tzinfo` before it stores.

Two things follow. A zone-less timestamp that adk-python wrote resolves to the
instant it meant, whatever zone the reading process runs in. And the value
`createSession` writes equals the value `getSession` reads back, so a comparison
between them cannot fail on the offset alone.

An options object may say otherwise, and its value wins:

```ts
const service = new DatabaseSessionService({
  dbName: './sessions.db',
  driver: SqliteDriver,
  forceUtcTimezone: false,
});
```

A MySQL, MariaDB or SQL Server database that an earlier version of adk-js wrote
from a non-UTC process holds local wall clocks. Those rows now read back shifted
by that process's offset.

## Releasing the connection

`close()` returns the connections the service opened. Call it before a script
ends, or the sqlite driver holds its file and the process does not exit.

```ts
await service.close();
```

`close()` is safe to call before `init()` and safe to call twice; both do
nothing. A later `init()` reopens the database, and the service works again.

The service also implements `Symbol.asyncDispose`, so `await using` closes it at
the end of a block:

```ts
await using service = new DatabaseSessionService('sqlite://./sessions.db');
```

TypeScript compiles that statement under this repository's own `lib`
(`["ES2022", "DOM"]`). Plain JavaScript cannot use it on a runtime that does not
implement the syntax yet; call `close()` there.
