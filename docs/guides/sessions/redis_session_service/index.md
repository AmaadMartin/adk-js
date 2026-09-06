# RedisSessionService

`RedisSessionService` stores sessions, events and state in Redis. Reach for it
when several processes must share one conversation, when sessions have to
survive a restart, and when you do not want to run a SQL database for it.

## Introduction

`InMemorySessionService` loses everything when the process exits, and it is
private to that process. `DatabaseSessionService` fixes both, but it asks you to
run and migrate a SQL database. `RedisSessionService` sits between them: one
Redis instance, no schema, and every runner pointed at it reads the same
sessions.

Three properties are worth knowing before you choose it.

**It shares its key layout with adk-python.** The keys and the stored payloads
match `google.adk.integrations.redis`, so an adk-js runner and an adk-python
runner can back the same conversations from one instance. The key schema is
below.

**Every key expires.** The service applies a TTL to every key it writes, seven
days by default. That bounds what Redis holds without a cleanup job, and it also
means a session nobody touches disappears. Set `ttlSeconds` to `0` to store
without expiry.

**State is split across three keys by scope.** A `user:` key is shared by all of
one user's sessions, an `app:` key by every session of the application, and an
unprefixed key belongs to the one session. `temp:` state is never written
anywhere. `getSession` merges the three scopes back together, so a change one
session makes to `user:theme` is visible to that user's other sessions on their
next read.

## Get started

Install the client. `redis` is an optional peer dependency, so it is not
downloaded unless you ask for it.

```bash
npm install redis
```

```ts
import {createEvent, RedisSessionService} from '@google/adk';

const service = new RedisSessionService({uri: process.env.REDIS_URL});

const session = await service.createSession({
  appName: 'my_app',
  userId: 'user-123',
  state: {'app:tier': 'gold', 'user:locale': 'en-US', turn: 0},
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

await service.close();
```

`loaded.state` carries all three scopes: `app:tier`, `user:locale` and `turn`.

## Configuration

| Option       | Type              | Default        | Description                                                                                                         |
| ------------ | ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `uri`        | `string`          | none           | Connection URI, `redis://[:password@]host:port/db` or `rediss://…` for TLS. Takes precedence over the fields below. |
| `host`       | `string`          | `localhost`    | Redis hostname.                                                                                                     |
| `port`       | `number`          | `6379`         | Redis port.                                                                                                         |
| `password`   | `string`          | none           | Password for authentication.                                                                                        |
| `ssl`        | `boolean`         | `false`        | Connect over TLS.                                                                                                   |
| `db`         | `number`          | `0`            | Database index.                                                                                                     |
| `ttlSeconds` | `number`          | `604800`       | Expiry for every key the service writes. Zero or negative disables expiry.                                          |
| `keyPrefix`  | `string`          | `adk:session:` | Prefix for every key the service writes.                                                                            |
| `client`     | `RedisClientLike` | none           | A client you already connected. The service never connects or closes it.                                            |

## Key schema

| Key                                         | Value                                                                           | Shared by                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| `{keyPrefix}{appName}:{userId}:{sessionId}` | The session envelope: id, session-scoped state, events, and `last_update_time`. | One session.                      |
| `{keyPrefix}user_state:{appName}:{userId}`  | A JSON object of `user:` keys, prefix stripped.                                 | Every session of one user.        |
| `{keyPrefix}app_state:{appName}`            | A JSON object of `app:` keys, prefix stripped.                                  | Every session of the application. |

The envelope uses adk-python's `snake_case` field names. Both clocks in it —
`last_update_time` and each event's `timestamp` — are written as POSIX seconds,
which is what adk-python stores. adk-js holds them in milliseconds and converts
in both directions, so a session written by either runtime reads correctly in
the other.

## Connection lifecycle

The service connects on the first call that touches Redis, not in the
constructor, and it caches the connection so two concurrent first calls share
one socket. A failed attempt is not cached: the call rejects, the half-open
client is released, and the next call reconnects. `close()` closes a connection
the service opened. A client you passed in through `client` belongs to you: the
service never connects or closes it, so close it yourself.

## Failure modes

| Situation                                           | Behaviour                                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSession` with an id that already exists      | Throws `AlreadyExistsError`. The write uses `SET … NX`, so it cannot overwrite. Any `app:` and `user:` state in the request is written before that check, as in adk-python. |
| `redis` is not installed and no client was passed   | Throws an error naming the package and the `npm install` command.                                                                                                           |
| `getSession` on a session that is absent or expired | Resolves `undefined`.                                                                                                                                                       |
| `deleteSession` on a session that is absent         | Resolves. The shared state keys are untouched.                                                                                                                              |
| `getUserState` with nothing stored                  | Resolves `{}`.                                                                                                                                                              |
| A scanned key holds something that is not a session | The listing skips it and logs a warning naming the key.                                                                                                                     |
| A session key holds something that is not a session | `getSession` resolves `undefined` and logs the same warning.                                                                                                                |
| `numRecentEvents` is negative                       | Throws `InputValidationError` before any read.                                                                                                                              |
| The connection drops                                | The service logs the error with the password redacted, and the failing command rejects.                                                                                     |

## Differences from adk-python

The wire format is identical. The behaviour differs in five places, each of
which is an adk-js capability that adk-python's signature has no room for.

- `listSessions` honours `order: 'asc' | 'desc'` and defaults to descending.
  adk-python always sorts descending.
- `listSessions` honours `limit`, `offset` and `page`, and fills in
  `page` / `limit` / `totalItems` / `totalPages`.
- `appendEvent` returns before any write when `event.partial` is set, which is
  the adk-js contract. adk-python writes the session on every streamed chunk.
- A negative `numRecentEvents` throws. adk-python reverses the slice instead.
- The application name and the user ID are escaped before they go into the
  `SCAN` pattern, so a user ID of `*` cannot widen the pattern onto another
  user's sessions. adk-python interpolates them unescaped.

## Differences from the other adk-js session services

Two behaviours follow adk-python where the adk-js interface documents something
else. Both are visible to a caller that swaps this service for another.

- `ListSessionsRequest.order` says no ordering is applied when it is omitted.
  This service sorts descending instead, because `SCAN` returns keys in an
  order that varies between calls, so "no ordering" would mean a result that
  changes between two sweeps of the same keys.
- `ListSessionsResponse` says state is not set on the returned sessions, and
  `InMemorySessionService` returns `state: {}`. This service merges the app,
  user and session scopes into each listed session, which is what adk-python
  does and what its `test_list_sessions_state_merging` asserts. Events are
  still left empty.
