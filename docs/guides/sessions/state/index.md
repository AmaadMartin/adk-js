# Session state and its scopes

Session state is the key/value map an agent run reads and writes alongside the
event history. A key prefix decides how far a value travels: to one session, to
every session of one user, or to every session of the app.

## Introduction

A `Session` holds two things a later turn needs: the ordered `events` that
become the model's context, and a `state` map for values you want to read back
without re-parsing the transcript. Events are append-only; state is the part you
overwrite.

State is not one store. `InMemorySessionService` keeps three: one per session,
one per `(appName, userId)` pair, and one per `appName`. A key's prefix selects
the store it is written to. Reads always see all three merged together, so an
agent never has to know which store a value came from, while a write to
`user:locale` in one session is visible in that user's next session.

Prefixes are part of the wire contract, not a local convention. `app:`, `user:`
and `temp:` mean the same thing in every ADK language and in every session
service. A backend may still refuse part of it: `VertexAiSessionService`
forwards a state delta to the Agent Engine API without splitting it, and its
`getUserState` throws.

## Get started

`InMemorySessionService` needs no configuration. This example writes all three
scopes at creation, commits one more write through an event, and reads the
session back.

```ts
import {
  InMemorySessionService,
  createEvent,
  createEventActions,
} from '@google/adk';

const sessionService = new InMemorySessionService();

// Prefixed keys go to the shared stores; `turn` stays on this session.
const session = await sessionService.createSession({
  appName: 'hello_world',
  userId: 'user-123',
  state: {'app:tier': 'free', 'user:locale': 'en-US', turn: 0},
});
// session.state === {'app:tier': 'free', 'user:locale': 'en-US', turn: 0}

await sessionService.appendEvent({
  session,
  event: createEvent({
    author: 'assistant',
    timestamp: Date.now(),
    actions: createEventActions({stateDelta: {turn: 1}}),
  }),
});

const loaded = await sessionService.getSession({
  appName: 'hello_world',
  userId: 'user-123',
  sessionId: session.id,
});
// loaded.state.turn === 1, loaded.events.length === 1
```

## The four scopes

| Prefix  | Store                          | Visible to                  |
| ------- | ------------------------------ | --------------------------- |
| `app:`  | one per `appName`              | every session of the app    |
| `user:` | one per `appName` and `userId` | every session of that user  |
| none    | the session                    | that session                |
| `temp:` | none                           | the current invocation only |

A `temp:` entry is never committed. `createSession` drops it from the initial
state, and `appendEvent` drops it from the event delta.

The prefix is stripped on the way into a shared store and added back on the way
out, so `user:locale` is stored as `locale` and read back as `user:locale`.

## Reading user state without a session

`getUserState` returns the user store directly, with un-prefixed keys. Use it to
bootstrap context before you have a session id, instead of listing sessions just
to reach one merged view.

```ts
const userState = await sessionService.getUserState({
  appName: 'hello_world',
  userId: 'user-123',
});
// userState === {locale: 'en-US'}
```

The result is a copy, so writing to it does not change the store. An app or user
with nothing stored gives `{}`.

`BaseSessionService` implements `getUserState` as a throwing default. A service
that cannot read user state without a session inherits it, so catch the error
and fall back to `listSessions` plus `getSession` if you support more than one
backend.

## What `listSessions` returns

Listed sessions carry the same merged state that `getSession` returns, so a
session picker does not need one round trip per row. Events are always dropped.

```ts
const {sessions} = await sessionService.listSessions({
  appName: 'hello_world',
  userId: 'user-123',
});
// sessions[0].state === {'user:locale': 'en-US', topic: 'billing'}
// sessions[0].events === []
```

The list is sorted by `lastUpdateTime`, then `userId`, then session id, so the
order is stable across calls. Pass `order: 'desc'` for newest-first.

## Failure modes

- **A duplicate session id is rejected.** `createSession` trims the id you pass
  and throws `AlreadyExistsError` if that app and user already hold it, rather
  than overwriting the stored session. A whitespace-only id counts as no id, so
  the service generates one. Call `getOrCreateSession` when you want the
  existing session back instead of an error.

- **Appending to an unknown session does nothing.** `appendEvent` logs a
  warning and returns the event when the app, user or session is not stored.
  It does not throw, and it leaves the session you passed untouched.

- **A re-delivered event is ignored.** An event whose id and fields match one
  already stored is dropped, so its state delta is applied once. An event that
  reuses a stored id with different content replaces that entry instead.

- **A partial event is ignored.** `appendEvent` returns immediately for
  `partial: true`, so a streaming chunk changes neither the events nor
  `lastUpdateTime`.

- **There is no atomic read-modify-write.** Two invocations that read the same
  key and write it back do not see each other.
