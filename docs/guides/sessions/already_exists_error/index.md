# AlreadyExistsError

`AlreadyExistsError` is the error a session service throws when you create a
session with an id that is already taken. Reach for it when your code picks its
own session ids and must tell "this id is taken" apart from a storage failure.

## Introduction

A session is identified by the triple `(appName, userId, sessionId)`, not by
`sessionId` alone. `createSession` generates a UUID when you omit `sessionId`,
so a generated id never collides. When you supply the id yourself, a collision
is possible, and the service rejects the create rather than replacing the
session that is already there. The existing session keeps its events and its
state.

`getSession` is the other half of the contract. It returns `undefined` for a
session that does not exist rather than throwing, so a missing session and a
duplicate session are two different signals.

Use the `isAlreadyExistsError` type guard to detect the error. Do not use
`instanceof AlreadyExistsError`: a process that loads two copies of
`@google/adk` gets two distinct classes, and the check then returns `false` for
an error the other copy threw. The guard matches on the error `name`, so it
works across that boundary.

`InMemorySessionService` and `DatabaseSessionService` both throw this error.
`VertexAiSessionService` forwards the id to the Agent Engine API, and that
service owns the conflict.

## Get started

```ts
import {InMemorySessionService, isAlreadyExistsError} from '@google/adk';

const sessionService = new InMemorySessionService();

await sessionService.createSession({
  appName: 'my-app',
  userId: 'u1',
  sessionId: 'chat-1',
});

try {
  await sessionService.createSession({
    appName: 'my-app',
    userId: 'u1',
    sessionId: 'chat-1',
  });
} catch (e) {
  if (!isAlreadyExistsError(e)) {
    throw e;
  }
  // e.message is 'Session with id chat-1 already exists.'
}
```

The same id under a different `userId` or a different `appName` is a different
session, so this succeeds:

```ts
await sessionService.createSession({
  appName: 'my-app',
  userId: 'u2',
  sessionId: 'chat-1',
});
```

## Resuming instead of failing

When you want the existing session rather than the error, call
`getOrCreateSession`. It reads the session first and creates one only when the
read finds nothing.

```ts
const session = await sessionService.getOrCreateSession({
  appName: 'my-app',
  userId: 'u1',
  sessionId: 'chat-1',
});
```

## The message

The error carries a message that names the id:

```
Session with id chat-1 already exists.
```

`new AlreadyExistsError()` with no argument uses the default message,
`The resource already exists.`.
