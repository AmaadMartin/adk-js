# User state and temp state

Session state has three scopes beyond the session itself. `getUserState` reads
the `user:` scope without a session id, `temp:` keys stay readable for one
invocation and never reach storage, and `flush` lets a buffering backend drain
its writes.

## Introduction

A `Session` holds one conversation, but not every value belongs to one
conversation. A key prefix picks the scope: `app:` for the whole application,
`user:` for one user across all their sessions, `temp:` for the current
invocation only, and no prefix for this session.

Two of those scopes need service-level support, and this is what
`BaseSessionService` provides.

The `user:` scope is stored per `(appName, userId)`, so reading it used to mean
loading a session. `getUserState` reads it directly. That matters when you want
a user's saved preferences _before_ the first session exists — otherwise you
list every session of that user and load one just to reach a merged state you
then have to un-prefix by hand. `getUserState` returns the raw keys, so
`user:profile` comes back as `profile`.

The `temp:` scope is the opposite problem. A value written as `temp:draft`
must reach the next agent in the same run, and must never be written to
storage. `appendEvent` applies the `temp:` entries of an event's state delta to
the in-memory session, then strips them from the delta before the event is
persisted. A `SequentialAgent` whose first node writes `output_key: 'temp:draft'`
can read `ctx.session.state['temp:draft']` in its second node, and a later
`getSession` shows no `temp:` key at all.

`flush` is a lifecycle hook. The default does nothing, because
`InMemorySessionService`, `DatabaseSessionService` and `VertexAiSessionService`
all write on `appendEvent`. A backend that batches writes overrides it.

## Get started

This example needs no model and no credentials.

```ts
import {InMemorySessionService, createEvent} from '@google/adk';

const sessionService = new InMemorySessionService();

const session = await sessionService.createSession({
  appName: 'notes',
  userId: 'ada',
  sessionId: 'monday',
});

await sessionService.appendEvent({
  session,
  event: createEvent({
    author: 'note_agent',
    actions: {
      stateDelta: {
        'temp:draft': 'hello', // this invocation only
        'user:name': 'Ada', // every session of this user
        headline: 'Monday notes', // this session only
      },
    },
  }),
});

// The in-hand session can still read the temp value.
session.state['temp:draft']; // 'hello'

// Storage cannot.
const reloaded = await sessionService.getSession({
  appName: 'notes',
  userId: 'ada',
  sessionId: 'monday',
});
'temp:draft' in reloaded!.state; // false
reloaded!.state['headline']; // 'Monday notes'

// User state is readable on its own, with the prefix removed.
await sessionService.getUserState({appName: 'notes', userId: 'ada'});
// {name: 'Ada'}
```

## Backends that cannot read user state

`getUserState` is optional. `InMemorySessionService` and
`DatabaseSessionService` implement it. `VertexAiSessionService` cannot read user
state independently of a session, so it inherits the base default, which rejects
with `NotImplementedError`:

```ts
import {NotImplementedError, VertexAiSessionService} from '@google/adk';

const sessionService = new VertexAiSessionService({
  projectId: 'my-project',
  location: 'us-central1',
});

try {
  await sessionService.getUserState({appName: 'agent-engine', userId: 'ada'});
} catch (error) {
  error instanceof NotImplementedError; // true
}
```

The message names the service and the workaround: enumerate sessions with
`listSessions`, then call `getSession` on each result to reach the merged state.

## Guarantees and limits

- `getUserState` returns a copy. Writing to the returned object does not change
  the stored state.
- `getUserState` returns `{}` when nothing is stored for that `(appName,
userId)`, and never returns session-scoped or `app:`-scoped keys.
- A `temp:` key never appears in `event.actions.stateDelta` after `appendEvent`,
  and never in a session returned by `getSession`.
- `DatabaseSessionService` rebuilds `session.state` from storage inside its own
  `appendEvent`, so `temp:` state is not readable across nodes on that backend.
  Use `InMemorySessionService` when a workflow depends on `temp:` values.
- `getSession` rejects a negative `numRecentEvents` with an
  `InputValidationError`. Use `0` for "no events" and omit the field for "no
  filter".
