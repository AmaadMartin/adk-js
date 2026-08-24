# AlreadyExistsError

`AlreadyExistsError` is the error a session service throws when you create a
session with an id that is already taken. Reach for it when your code picks its
own session ids and must tell "this id is taken" apart from a storage failure.

## Introduction

`createSession` generates a UUID when you omit `sessionId`, so a generated id
never collides. When you supply the id yourself, a collision is possible, and
the service rejects the create rather than replacing the session that is
already there. The existing session keeps its events and its state.

Detect the error with the `isAlreadyExistsError` type guard. Do not use
`instanceof AlreadyExistsError`: a process that loads two copies of
`@google/adk` gets two distinct classes, and the check then returns `false` for
an error the other copy threw. The guard matches on the error `name`, so it
works across that boundary.

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

A session is identified by the triple `(appName, userId, sessionId)`, so the
same id under a different `userId` or a different `appName` is a different
session and creates normally.
