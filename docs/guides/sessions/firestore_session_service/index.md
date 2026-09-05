# FirestoreSessionService

`FirestoreSessionService` stores sessions, their events and their shared state
in Google Cloud Firestore. Reach for it when several server instances serve one
application and each needs to read the sessions the others wrote, without you
running a SQL database.

## Introduction

`InMemorySessionService` loses everything when the process exits.
`SqliteSessionService` and `DatabaseSessionService` need a file or a SQL server
you operate. This service needs neither: Firestore is a managed document
database, so a horizontally-scaled deployment gets shared durable sessions with
no infrastructure of its own.

Three properties are worth knowing before you choose it.

It writes the document layout adk-python's `FirestoreSessionService` writes.
Field names, the JSON-encoded session state and the snake_case event body are
the same, so a database an adk-js runner writes is readable by an adk-python
runner, and the reverse holds.

It rejects a stale write. Every session document carries a `revision` number
that `appendEvent` increments. A session loaded at revision 3 cannot append
over a document that has since reached revision 4; the append throws
`StaleSessionError` and tells you to reload. `DatabaseSessionService` gives the
same guarantee.

It keeps app-scoped and user-scoped state in their own documents, outside the
session tree. Every session of one app reads one `app_states` document, and
every session of one user reads one `user_states` document, so a value written
in one session is visible in the next.

## Get started

`@google-cloud/firestore` is an optional peer dependency, so install it first:

```sh
npm install @google-cloud/firestore
```

```ts
import {createEvent, FirestoreSessionService} from '@google/adk';

const service = new FirestoreSessionService();

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
```

`getSession` resolves to `undefined` when nothing is stored. A session is
identified by the triple `(appName, userId, sessionId)`, not by `sessionId`
alone.

The service creates its own client on first use, which picks up Application
Default Credentials and the ambient project. Pass your own client when you need
a named database, another project, or the emulator:

```ts
import {Firestore} from '@google-cloud/firestore';

const service = new FirestoreSessionService({
  client: new Firestore({projectId: 'my-project', databaseId: 'sessions'}),
  rootCollection: 'adk-session',
});
```

`settings` is the alternative when you only want to configure the client the
service builds. It is ignored when you pass `client`.

## Document layout

```text
<rootCollection>/<appName>/users/<userId>/sessions/<sessionId>
                                                   └─ events/<eventId>
app_states/<appName>
user_states/<appName>/users/<userId>
```

`rootCollection` defaults to the `ADK_FIRESTORE_ROOT_COLLECTION` environment
variable, and to `adk-session` when that is unset. It is read once, when the
service is constructed.

A session document holds `id`, `appName`, `userId`, the JSON-encoded
session-scoped `state`, a server-stamped `createTime` and `updateTime`, and the
`revision` counter. An event document holds the event body under `event_data`
in snake_case, a server-stamped `timestamp`, and a denormalised `appName` and
`userId`.

`listSessions` without a `userId` reads every session of the app through a
collection-group query on `sessions`. Firestore needs a single-field index on
`appName` for that collection group; it creates one on first use, or you can
declare it up front.

## State scopes

A state key decides which document holds it.

| Prefix  | Document                               | Shared with                        |
| ------- | -------------------------------------- | ---------------------------------- |
| `app:`  | `app_states/<appName>`                 | every session of the app           |
| `user:` | `user_states/<appName>/users/<userId>` | every session of the user          |
| `temp:` | nothing                                | nobody: it never reaches Firestore |
| none    | the session document                   | that session                       |

App and user state is written natively, so a `Date` is stored as a Firestore
timestamp and reads back as one. The session bucket is JSON-encoded, so a value
JSON cannot represent is replaced with a string stand-in rather than failing
the write.

`getUserState` reads the user document directly, so you can load a user's
preferences before the first turn without listing their sessions:

```ts
const state = await service.getUserState({
  appName: 'my_app',
  userId: 'user-123',
});
```

The keys come back without the `user:` prefix, and the result is `{}` when
nothing is stored.

## Reading part of a transcript

`getSession` takes a config that limits which events come back:

```ts
const recent = await service.getSession({
  appName: 'my_app',
  userId: 'user-123',
  sessionId: session.id,
  config: {numRecentEvents: 20, afterTimestamp: Date.now() - 3_600_000},
});
```

`numRecentEvents: 0` returns the session with no events and issues no events
query at all, which is the cheap way to check that a session exists. A negative
value throws `InputValidationError`.

Timestamps are epoch milliseconds throughout adk-js, in `afterTimestamp`,
`Event.timestamp` and `Session.lastUpdateTime`. adk-python uses epoch seconds.
A session document written by adk-python therefore holds a number the service
scales when it reads it.

## Failure modes

| Condition                                             | What happens                        |
| ----------------------------------------------------- | ----------------------------------- |
| `createSession` with an id that exists                | `AlreadyExistsError`                |
| `appendEvent` on a session that is not stored         | `SessionNotFoundError`              |
| `appendEvent` after another writer moved the revision | `StaleSessionError`                 |
| `appendEvent` while `deleteSession` is running        | `Error`, naming the session         |
| `numRecentEvents` below zero                          | `InputValidationError`              |
| `@google-cloud/firestore` not installed               | an error naming the install command |

`deleteSession` marks the session `DELETING`, removes its events in batches of
500, and then deletes the session document. It proceeds even when the marker
write fails, so a session cannot be left undeletable; the failure is logged at
debug level.

`appendEvent` calls for one session are serialized inside a process, so two
concurrent turns on the same session do not race each other to the same
revision. Two processes are still ordered by the revision check, and the loser
gets `StaleSessionError`.

## Running against the emulator

```sh
gcloud emulators firestore start --host-port=localhost:8080
FIRESTORE_EMULATOR_HOST=localhost:8080 \
  npx tsx samples/sessions/firestore_session_service/round_trip.ts
```

The sample creates a session with all four state scopes, appends two events,
re-reads the session, lists sessions and deletes it.
