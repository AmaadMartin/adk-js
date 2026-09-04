# SqliteSessionService

`SqliteSessionService` stores sessions in one SQLite file through the `sqlite3`
driver, with no object-relational mapper. Reach for it when a single process
needs durable sessions on the local disk, and when a Python process running
adk-python has to read the same file.

## Introduction

`InMemorySessionService` loses everything when the process exits.
`DatabaseSessionService` keeps sessions in any SQL dialect MikroORM supports,
which is what you want for a shared server. Between them sits the case this
service covers: a command-line tool or a single-node service that wants one
file on disk and no driver configuration.

Two properties set it apart from `DatabaseSessionService`.

It writes the file layout adk-python's `SqliteSessionService` writes. Epochs are
`REAL` POSIX seconds, event payloads are snake_case JSON text, and the four
tables carry the same columns. A file this service writes opens in adk-python,
and the reverse holds.

It merges state in SQL rather than in TypeScript. An `appendEvent` that changes
`app:` state issues one `INSERT ... ON CONFLICT DO UPDATE` whose merge
expression reads the stored object and the delta together, so a concurrent
writer touching a different key cannot lose it to a read-modify-write race.
The merge follows `Object.assign` semantics: a key in the delta wins with its
delta value, JSON `null` included.

The two services are not interchangeable for a given file. The column types
differ and this service writes no schema-version table, so point each file at
one service and stay with it. adk-python keeps the same two services apart for
the same reason.

## Get started

The `sqlite3` driver is an optional peer dependency, so install it first:

```sh
npm install sqlite3
```

```ts
import {createEvent, SqliteSessionService} from '@google/adk';

const service = new SqliteSessionService('./.adk/session.db');

const session = await service.createSession({
  appName: 'my_app',
  userId: 'user-123',
  state: {locale: 'en-US'},
});

await service.appendEvent({
  session,
  event: createEvent({author: 'user', invocationId: 'inv-1'}),
});

const loaded = await service.getSession({
  appName: 'my_app',
  userId: 'user-123',
  sessionId: session.id,
});
```

`getSession` resolves to `undefined` when nothing is stored. A session is
identified by the triple `(appName, userId, sessionId)`, not by `sessionId`
alone.

## Database paths

The constructor takes a filesystem path, or a SQLAlchemy-style URL, so a
configuration value written for adk-python works unchanged:

| Argument                           | File opened                                      |
| ---------------------------------- | ------------------------------------------------ |
| `./session.db`                     | `./session.db`                                   |
| `sqlite:///relative.db`            | `relative.db`, relative to the working directory |
| `sqlite:////var/lib/adk.db`        | `/var/lib/adk.db`                                |
| `sqlite+aiosqlite:///x.db?mode=ro` | `x.db`, opened read-only                         |

A query string turns the path into a SQLite URI, so `mode=ro` and the other
[URI parameters](https://www.sqlite.org/uri.html) reach the driver. Opening a
read-only database and then writing to it fails with the driver's error.

## State scopes

The `app:` and `user:` prefixes decide what a value is shared with, as they do
in every session service:

```ts
await service.createSession({
  appName: 'my_app',
  userId: 'user-123',
  state: {
    'app:theme': 'dark', // every session of my_app
    'user:locale': 'en-US', // every session of user-123 in my_app
    'draft': 'hello', // this session only
    'temp:scratch': 1, // never persisted
  },
});
```

A `temp:` value is applied to the in-memory session so a later agent in the same
invocation can read it, then trimmed out before the event is written.

A value no JSON column can hold — a `BigInt`, a circular object, a function —
is persisted as its string representation and logged as a warning, rather than
failing the whole write.

## Failure modes

| Condition                                                  | Error                                              |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `createSession` with an id that exists                     | `AlreadyExistsError`                               |
| `appendEvent` on a session storage does not hold           | `SessionNotFoundError`                             |
| `appendEvent` with a session older than storage            | `StaleSessionError`                                |
| A database written before adk-python's `event_data` column | `Error` naming adk-python's migration command      |
| `sqlite3` is not installed                                 | `Error` naming the feature and the install command |

`StaleSessionError` means another writer advanced the session after you loaded
it. Recover by calling `getSession` again and replaying the append against the
fresh copy.

## What it does not do

`listSessions` returns the whole result set as one page, ordered oldest active
first. The `limit`, `offset`, `page` and `order` fields of
`ListSessionsRequest` are ignored, because the adk-python reference has no
pagination. Use `DatabaseSessionService` when a caller needs them.

`getSessionServiceFromUri` still routes every `sqlite://` URI to
`DatabaseSessionService`. Construct `SqliteSessionService` directly to use it.
