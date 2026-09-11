# FirestoreSessionService

`FirestoreSessionService` stores sessions, their events and their shared state
in Google Cloud Firestore. Reach for it when several processes serve the same
users and you want a managed document store rather than a SQL server.

## Introduction

`BaseSessionService` has four backends in ADK for TypeScript.
`InMemorySessionService` loses everything when the process exits.
`DatabaseSessionService` needs a SQL server and a driver.
`VertexAiSessionService` ties sessions to an Agent Engine.
`FirestoreSessionService` sits between the last two: a managed store with no
server to run, and no dependency on Agent Engine.

It differs from the others in one way that changes how you write code around
it. Two processes can hold the same session at once, so a write can be based on
a session that is already out of date. The service stamps every session it
loads with the revision it read, and rejects an append whose revision no longer
matches storage. You get a `StaleSessionError` instead of a lost write.

`@google-cloud/firestore` is an optional peer dependency. Install it alongside
the integrations package:

```sh
npm install @google/adk-integrations @google-cloud/firestore
```

## Get started

```ts
import {createEvent} from '@google/adk';
import {FirestoreSessionService} from '@google/adk-integrations';

const sessions = new FirestoreSessionService();

const session = await sessions.createSession({
  appName: 'my_app',
  userId: 'u1',
  state: {'app:tier': 'gold', 'user:locale': 'en-GB', topic: 'weather'},
});

await sessions.appendEvent({
  session,
  event: createEvent({
    invocationId: 'inv-1',
    author: 'user',
    actions: {stateDelta: {topic: 'traffic'}},
  }),
});

const loaded = await sessions.getSession({
  appName: 'my_app',
  userId: 'u1',
  sessionId: session.id,
});
// loaded.state is
// {'app:tier': 'gold', 'user:locale': 'en-GB', topic: 'traffic'}
```

`getSession` resolves `undefined` when there is no such session.

## Configuration

The constructor takes one options object, and both fields are optional.

```ts
import {Firestore} from '@google-cloud/firestore';
import {FirestoreSessionService} from '@google/adk-integrations';

const sessions = new FirestoreSessionService({
  client: new Firestore({projectId: 'my-project'}),
  rootCollection: 'my-sessions',
});
```

Without a `client`, the service builds one on first use from the ambient
project and credentials. The root collection name falls back to the
`ADK_FIRESTORE_ROOT_COLLECTION` environment variable, then to `adk-session`.

## Document layout

```
<rootCollection>/{appName}/users/{userId}/sessions/{sessionId}
  └─ events/{eventId}
app_states/{appName}
user_states/{appName}/users/{userId}
```

The field names are the ones adk-python's `FirestoreSessionService` writes, so
a Python service and a TypeScript service can share one database.

State is split by prefix when it is written. An `app:` key goes to
`app_states`, a `user:` key to `user_states`, and everything else into the
session document. `getSession` merges the three back together and restores the
prefixes. A `temp:` key is never written at all.

App state and user state are written as native Firestore values, so a `Date`
comes back as a timestamp. The session's own state is stored as one JSON
string, so a value JSON cannot represent — a function, a `bigint` — is replaced
by its string form and a warning is logged. Nothing is dropped and no write
fails.

## Concurrent writes

Every append raises a revision counter on the session document, and a session
carries the revision it was loaded at.

```ts
import {isStaleSessionError} from '@google/adk';

try {
  await sessions.appendEvent({session, event});
} catch (error) {
  if (!isStaleSessionError(error)) {
    throw error;
  }
  // Another writer changed the session: load it again and append to that.
  const fresh = await sessions.getSession({appName, userId, sessionId});
  if (fresh) {
    await sessions.appendEvent({session: fresh, event});
  }
}
```

A session built by hand, rather than returned by `createSession` or
`getSession`, carries no revision. Its first append is accepted whatever the
stored revision is, and the session is stamped from then on.

Within one process, appends to the same session are serialized, so two
concurrent `appendEvent` calls on one session both land instead of racing.
Across processes, the revision check is what protects the write.

## Deleting

`deleteSession` marks the session, deletes its events in batches of 500, then
deletes the session document. An append that arrives while the marker is set
is rejected. The marker is best effort: if it cannot be written, the deletion
still goes ahead.
