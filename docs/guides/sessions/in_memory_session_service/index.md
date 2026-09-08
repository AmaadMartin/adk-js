# InMemorySessionService

`InMemorySessionService` keeps every session in process memory. Reach for it in
development, in tests, and in single-process tools where a conversation does not
have to survive a restart.

## Introduction

`InMemorySessionService` implements `BaseSessionService` against three
null-prototype maps: one for sessions, one for user-scoped state, and one for
app-scoped state. Nothing is written to disk and nothing is shared between
processes, so two server replicas do not see each other's sessions. Use
`DatabaseSessionService` or `VertexAiSessionService` when a session must outlive
the process.

The service never hands out the session object it stores. `createSession` and
`getSession` return a copy, so a caller can read and edit the result without
corrupting the store. Two behaviours follow from that design and are worth
knowing before you build on the service: an append to a session the store does
not hold is an error, and the cost of the copy is tunable.

## Get started

```ts
import {InMemorySessionService, createEvent} from '@google/adk';

const sessionService = new InMemorySessionService();

const session = await sessionService.createSession({
  appName: 'hello-world',
  userId: 'user-123',
  state: {locale: 'en-US'},
});

await sessionService.appendEvent({
  session,
  event: createEvent({author: 'user', timestamp: Date.now()}),
});

// One event, and the state the session was created with.
const loaded = await sessionService.getSession({
  appName: 'hello-world',
  userId: 'user-123',
  sessionId: session.id,
});
```

`getSession` returns `undefined` when the app, the user, or the session id is
unknown.

## Appending to a session that is not stored

`appendEvent` throws `SessionNotFoundError` when the store holds no session for
the given app, user, and session id. The check runs before any mutation, so a
failed append never applies half of the event's state delta.

```ts
import {
  InMemorySessionService,
  SessionNotFoundError,
  createEvent,
} from '@google/adk';

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'hello-world',
  userId: 'user-123',
});
await sessionService.deleteSession({
  appName: 'hello-world',
  userId: 'user-123',
  sessionId: session.id,
});

try {
  await sessionService.appendEvent({
    session,
    event: createEvent({author: 'user', timestamp: Date.now()}),
  });
} catch (error) {
  // Match on `name`, not `instanceof`: a runtime that loaded two copies of
  // `@google/adk` fails the constructor check across the copies.
  if (error instanceof Error && error.name === 'SessionNotFoundError') {
    // The session is gone. Create a new one.
  }
}
```

A partial event is the one exception. `appendEvent` returns it unchanged before
the lookup, because a streaming chunk is not persisted and must not fail a run.

## Light copies

By default each `createSession` and `getSession` deep-clones the session it
returns, which recursively clones every event. A long conversation makes that
cost grow with its history, and it is paid on every read.

The `IN_MEMORY_SESSION_SERVICE_LIGHT_COPY` feature replaces the deep clone with
a copy of the containers alone. The returned session gets its own `events` array
and its own `state` map, so adding an event or a state key still leaves the
stored session untouched. The event objects and the state values inside those
containers are shared with the store, so editing one in place is visible to the
next reader.

Turn it on programmatically:

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY, true);
```

Or through the environment, before the process starts:

```sh
export ADK_ENABLE_IN_MEMORY_SESSION_SERVICE_LIGHT_COPY=1
```

The feature is at stage `WIP` and is off by default, so the deep clone stays the
behaviour you get until you opt in. Enable it only if your code treats the
sessions it reads as read-only, or mutates them by replacement rather than in
place.
