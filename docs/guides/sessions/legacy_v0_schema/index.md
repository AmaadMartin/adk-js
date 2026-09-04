# The legacy v0 session schema

adk-python versions 1.19.0 to 1.21.0 wrote sessions in a schema whose `events`
table spreads each event across typed columns and stores the event's actions as
a Python pickle. `schema_v0.ts` reads and writes that table from adk-js, so a
database those versions created keeps working when a Node process joins it.

## Introduction

The current schema stores a whole event as JSON in one `event_data` column.
The legacy schema does not: it has a column per field, and one `actions` column
holding a pickled `EventActions`. adk-python still picks the legacy classes at
runtime when a database has no `adk_internal_metadata` row, and it both reads
and writes them, so the schema is not historical — it is live wherever a
database was never migrated.

Reach for this module when a database predates the JSON schema and you cannot
migrate it yet, typically because a Python worker still writes to it. Two
things follow from the pickle.

The first is a security boundary. Python's unpickler resolves whatever global a
payload names and calls it, which makes loading an untrusted blob equivalent to
running the code that wrote it. `decodeEventActionsPickle` executes nothing: it
reads the payload through an allowlist of the types `EventActions` can hold and
refuses every other global, mirroring adk-python's `_restricted_pickle`.

The second is that a refusal is an error, not an empty value. A payload that
cannot be decoded throws, because returning default actions would silently drop
a `stateDelta` that a later write then overwrites.

## Get started

The legacy schema module ships inside `@google/adk` and is not on the package's
public entry point, so today it is reached from inside the package. Register
`ENTITIES_V0` in place of `ENTITIES`, then convert rows with the two functions
the module exports.

```ts
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {createEvent} from '../../events/event.js';
import {createEventActions} from '../../events/event_actions.js';
import {StorageSession} from './schema.js';
import {
  ENTITIES_V0,
  StorageEventV0,
  storageEventV0FromEvent,
  storageEventV0ToEvent,
} from './schema_v0.js';

const orm = await MikroORM.init({
  dbName: 'legacy.sqlite',
  driver: SqliteDriver,
  entities: ENTITIES_V0,
});
const em = orm.em.fork();

const storageSession = await em.findOneOrFail(StorageSession, {
  appName: 'my_app',
  userId: 'u1',
  id: 's1',
});

// Write an event, actions and all.
const event = createEvent({
  invocationId: 'inv-1',
  author: 'agent',
  actions: createEventActions({stateDelta: {'user:name': 'Ada'}}),
});
em.create(StorageEventV0, storageEventV0FromEvent(storageSession, event));
await em.flush();

// Read it back. `actions.stateDelta` survives the round trip.
const row = await em.findOneOrFail(StorageEventV0, {id: event.id});
const readBack = storageEventV0ToEvent(row);
```

An adk-python process reading that row gets a real `EventActions` model,
because `encodeEventActionsPickle` writes the payload shape CPython produces
for a pydantic v2 model.

## What the allowlist admits

`decodeEventActionsPickle` resolves three groups of globals and refuses the
rest:

- the Python builtin and standard-library data types, matching adk-python's
  `_STATIC_ALLOWED_GLOBALS` entry for entry;
- the adk-python and FastAPI model classes an `EventActions` can hold, such as
  `AuthConfig` and `ToolConfirmation`;
- every class in `google.genai.types`.

adk-python derives its model set by walking pydantic field annotations.
TypeScript has no runtime annotation tree, so the adk-js list is declared: a
model added to `EventActions` in Python needs a line added to
`event_actions_pickle.ts`.

A refused global throws `PickleSecurityError`, which names the `module.name`
that was refused. A malformed payload throws `PickleError`. Both come from
`core/src/utils/pickle_utils.ts`.

## Column behaviour to know about

`actions` is declared `LONGBLOB` on MySQL and MariaDB. Their `BLOB` holds 64
KiB, and a large `stateDelta` overruns it: the insert fails rather than
truncating. Every other platform gets its own default blob column. adk-python
also has a Spanner branch here; adk-js has no Spanner driver.

`errorMessage` is truncated to 256 characters before the write, and the
truncated value ends with `...[truncated]`. A database written by an older ADK
can still carry a `VARCHAR(256)` column that was never altered after the schema
definition moved to text, and truncating turns a failed write into a shortened
value. Each truncation logs a warning naming both lengths.

The event index is named `idx_events_app_user_session_ts`, which is the name
adk-python's v0 schema declares. `ENTITIES_V0` and `ENTITIES` both describe the
`events` table, and only one of the two sets is ever registered with a
`MikroORM` instance.

## Differences from adk-python

| Behaviour               | adk-python                        | adk-js                                          |
| ----------------------- | --------------------------------- | ----------------------------------------------- |
| Event timestamps        | POSIX seconds                     | milliseconds                                    |
| `long_running_tool_ids` | a `set`                           | an array, so the stored JSON has a stable order |
| Allowed model classes   | derived from pydantic annotations | declared                                        |
| Spanner blob column     | `SpannerPickleType`               | no Spanner driver                               |
| `update_timestamp_tz`   | a second accessor                 | folded into `toSession`                         |
| Key column width        | 128 characters                    | 191, the MySQL `utf8mb4` index limit            |
