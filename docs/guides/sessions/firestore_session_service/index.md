# FirestoreSessionService

`FirestoreSessionService` stores sessions, events and state in Google Cloud
Firestore. Reach for it when a conversation must survive a restart, when more
than one process appends to the same conversation, and when you want a managed
document store rather than a SQL server.

## Introduction

`InMemorySessionService` keeps everything in process maps, so nothing survives
a restart and two workers never see each other's turns. `DatabaseSessionService`
solves that with SQL, at the cost of running a database.
`FirestoreSessionService` solves it with Firestore instead: there is no server
to run, the client authenticates with application default credentials, and
scaling is Google's problem.

Sharing a conversation creates a problem the in-memory service does not have.
Two turns can load the same `Session` object and both append to it. The second
append would overwrite the first turn's history. This service detects that: it
stamps every session it returns with the storage revision it was loaded at, and
`appendEvent` rejects a write whose revision no longer matches.

The document layout matches adk-python's `FirestoreSessionService` field for
field. A team can run both SDKs against one Firestore database: adk-js reads
the sessions adk-python wrote, and adk-python reads the sessions adk-js wrote.

The service ships in `@google/adk-integrations`, which declares
`@google-cloud/firestore` as a dependency. Install the package and the client
comes with it:

```bash
npm install @google/adk-integrations
```

## Get started

```ts
import {createEvent} from '@google/adk';
import {FirestoreSessionService} from '@google/adk-integrations';

const service = new FirestoreSessionService();

const session = await service.createSession({
  appName: 'my-app',
  userId: 'u1',
  state: {'app:tier': 'pro', 'user:locale': 'en-GB', turn: 0},
});

await service.appendEvent({session, event: createEvent({author: 'user'})});

const reloaded = await service.getSession({
  appName: 'my-app',
  userId: 'u1',
  sessionId: session.id,
  config: {numRecentEvents: 20},
});
```

The default client reads application default credentials. Pass `client` to
name a project, a database or an emulator:

```ts
import {Firestore} from '@google-cloud/firestore';

const scoped = new FirestoreSessionService({
  client: new Firestore({projectId: 'my-project'}),
  rootCollection: 'my-sessions',
});
```

## Document layout

Sessions and their events:

```
adk-session
└── <app name>
    └── users
        └── <user id>
            └── sessions
                └── <session id>
                    └── events
                        └── <event id>
```

Shared app and user state:

```
app_states
└── <app name>

user_states
└── <app name>
    └── users
        └── <user id>
```

A session document holds `id`, `appName`, `userId`, `state`, `createTime`,
`updateTime` and `revision`. `state` is the session-scoped state as JSON text;
`createTime` and `updateTime` are Firestore server timestamps. An event
document holds `event_data`, `timestamp`, `appName` and `userId`.

`adk-session` is the default root collection. Change it per service, or for
the whole process with `ADK_FIRESTORE_ROOT_COLLECTION`:

```ts
const service = new FirestoreSessionService({rootCollection: 'my-sessions'});
```

The explicit option wins, then the environment variable, then the default. An
empty string counts as unset and falls through to the next one.

## State scopes

A state key's prefix decides where it is stored:

| Key          | Stored in                          | Shared with                 |
| ------------ | ---------------------------------- | --------------------------- |
| `app:<key>`  | `app_states/<app name>`            | every user and session      |
| `user:<key>` | `user_states/<app name>/users/...` | every session of that user  |
| `temp:<key>` | nowhere                            | the current invocation only |
| `<key>`      | the session document               | that session                |

The prefix is stripped before the value is written, so `app:tier` is stored as
`tier`. Reads put it back, so `session.state` always carries the prefixed form.

App and user state is written to Firestore natively, so a `Date` stays a
Firestore timestamp. Session state goes through `JSON.stringify`, so a `Date`
persists as its ISO string. A value that JSON cannot represent — a function, a
symbol, a bigint, a circular structure — is replaced by its string form and a
warning is logged, rather than the key vanishing or the write failing.

## Concurrent writes

Every session this service returns carries `storageUpdateMarker`, the storage
revision it was read at. `appendEvent` compares it against the document inside
the write transaction, and throws `StaleSessionError` when storage has moved
on. Recover by loading the session again and replaying the turn:

```ts
import {StaleSessionError} from '@google/adk';

try {
  await service.appendEvent({session, event});
} catch (err: unknown) {
  if (!(err instanceof StaleSessionError)) {
    throw err;
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

A session you built by hand carries no marker, and its first append adopts
whatever revision storage holds. That is the escape hatch for a caller that
knows it is the only writer.

Appends to one session from within one process are serialized, so two turns of
the same conversation queue rather than race. Across processes the revision
check is what protects the history.

## Listing sessions

`listSessions` with a `userId` reads that user's `sessions` subcollection.
Without one it runs a collection-group query across every user, filtered by
`appName`.

A collection-group query needs a collection-group index. Create one on the
`sessions` collection for the `appName` field before calling `listSessions`
without a `userId`; a query scoped to one user needs no extra index.

Sessions come back ordered by last update time, then user id, then session id.
`order: 'desc'` reverses that. `limit`, `page` and `offset` slice the result,
and the response reports `page`, `limit`, `totalItems` and `totalPages`:

```ts
const {sessions, totalPages} = await service.listSessions({
  appName: 'my-app',
  limit: 20,
  page: 2,
});
```

Firestore cannot offset a collection-group scan cheaply, so the slice happens
in the client after the whole result set is read.

## Errors

| Condition                                      | Error                       |
| ---------------------------------------------- | --------------------------- |
| `createSession` with an id that already exists | `AlreadyExistsError`        |
| `appendEvent` on a missing session             | `SessionNotFoundError`      |
| `appendEvent` on a session storage moved past  | `StaleSessionError`         |
| `appendEvent` on a session being deleted       | `Error`, naming the session |

`getSession` for a session that is not there is not an error: it resolves
`undefined`.

## Deleting

`deleteSession` marks the session `DELETING`, removes its events in batches of
500, then removes the session document. An `appendEvent` that arrives while the
marker is set is rejected. The marker is best effort: if it cannot be written,
the delete still proceeds.

Deleting a session leaves the `app_states` and `user_states` documents alone,
because other sessions share them.
