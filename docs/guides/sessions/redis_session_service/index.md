# RedisSessionService

`RedisSessionService` stores sessions, events and state in Redis. Reach for it
when several processes must share one conversation, when sessions have to
survive a restart, and when you do not want to run a SQL database for it.

## Introduction

`InMemorySessionService` loses everything when the process exits, and it is
private to that process. `DatabaseSessionService` fixes both, but it asks you to
run and migrate a SQL database. `RedisSessionService` sits between them: one
Redis instance, no schema, and every runner pointed at it reads the same
sessions — including an adk-python runner, because the key layout below is the
one `google.adk.integrations.redis` uses.

Two properties decide whether it suits you. Every key expires, seven days by
default, which bounds what Redis holds without a cleanup job but also means an
untouched session disappears; set `ttlSeconds` to `0` to store without expiry.
State is split by scope across three keys, so a `user:` key is shared by all of
one user's sessions and an `app:` key by every session of the application, while
`temp:` state is never written anywhere.

Every option is documented on `RedisSessionServiceOptions` in the API reference.

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

## Key schema

| Key                                         | Value                                                                           | Shared by                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| `{keyPrefix}{appName}:{userId}:{sessionId}` | The session envelope: id, session-scoped state, events, and `last_update_time`. | One session.                      |
| `{keyPrefix}user_state:{appName}:{userId}`  | A JSON object of `user:` keys, prefix stripped.                                 | Every session of one user.        |
| `{keyPrefix}app_state:{appName}`            | A JSON object of `app:` keys, prefix stripped.                                  | Every session of the application. |

The envelope uses adk-python's `snake_case` field names. Both clocks in it,
`last_update_time` and each event's `timestamp`, are written as POSIX seconds,
which is what adk-python stores. adk-js holds them in milliseconds and converts
in both directions, so a session written by either runtime reads correctly in
the other.

## Differences from adk-python

The wire format is identical. Five behaviours differ, each an adk-js capability
that adk-python's signature has no room for.

- `listSessions` honours `order: 'asc' | 'desc'`, and `limit` / `offset` /
  `page`, filling in all four response fields.
- `appendEvent` returns before any write when `event.partial` is set, which is
  the adk-js contract. adk-python writes the session on every streamed chunk.
- A negative `numRecentEvents` throws. adk-python reverses the slice instead.
- The application name and the user ID are escaped before they go into the
  `SCAN` pattern, so a user ID of `*` cannot widen the pattern onto another
  user's sessions. adk-python interpolates them unescaped.
- A scanned key holding something that is not a session envelope is skipped
  with a warning, rather than failing the listing.

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
