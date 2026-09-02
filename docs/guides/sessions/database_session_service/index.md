# DatabaseSessionService

`DatabaseSessionService` stores sessions, events and state in a SQL database
through MikroORM. Reach for it when a conversation must survive a restart, or
when more than one process appends to the same conversation.

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

The driver package for your database is an optional peer dependency. Install
the one you need, for example `@mikro-orm/sqlite` or `@mikro-orm/postgresql`.

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

The supported connection-string schemes are `sqlite://`, `postgres://`,
`postgresql://`, `mysql://`, `mariadb://` and `mssql://`. The constructor
rejects anything else at once, with the password removed from the message. Use
`sqlite://:memory:` for a throwaway database.

Every method connects on first use. Call `init()` during startup to pay that
cost upfront instead. It is safe to call twice and safe to call concurrently.

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
connection pool:

```ts
import {MikroORM} from '@mikro-orm/core';

const service = new DatabaseSessionService(orm);
await service.close(); // `orm` stays open; the caller closes it.
```

`close()` only disposes an ORM this service created. It is safe to call twice,
and safe to call before `init()`. It does not retire the service: a later call
connects again, which is what the adk-python service does too. Note what that
means for `sqlite://:memory:`, whose database lives inside the connection —
reconnecting there opens a new, empty one.

A connection string accepts a second argument of MikroORM options, merged over
the ones derived from the URI:

```ts
const service = new DatabaseSessionService('postgres://localhost/adk', {
  pool: {min: 2, max: 10},
});
```

## Failure modes

| Condition                                        | Result                           |
| ------------------------------------------------ | -------------------------------- |
| `createSession` with an id that exists           | `AlreadyExistsError`             |
| `appendEvent` on a session storage does not hold | `SessionNotFoundError`           |
| `appendEvent` from a superseded session          | `StaleSessionError`              |
| An app or user state row is missing              | `Error` naming the missing scope |
| The database holds the legacy v0 schema          | `Error` from `init()`            |

The v0 schema is the one adk-python wrote before event data moved to JSON. It
stores event actions as a Python pickle, which this SDK cannot read, so
`init()` refuses the database rather than upgrading it in place. Migrate it
with the adk-python `adk migrate session` command first.

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
