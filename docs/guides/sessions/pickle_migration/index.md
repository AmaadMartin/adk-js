# Migrating a pickle sessions database

`migrate()` copies an adk-python **v0 (pickle)** sessions database into a
**v1 (JSON)** one that `DatabaseSessionService` can open and write. Reach for
it when adk-js refuses to use a database an older adk-python created.

## Introduction

adk-python's first `DatabaseSessionService` schema, called v0 here, spread each
event over its own columns and stored the event's `actions` as a Python pickle
blob. The schema in use now, v1, stores the whole event as JSON in a single
`event_data` column and records `schema_version = 1` in an
`adk_internal_metadata` table.

adk-js only writes v1. It detects the v0 layout and refuses to write to it,
because appending a v1 event to a v0 table would produce a database neither SDK
can read. Until now the only way forward was adk-python's
`adk migrate session` command, which needs a Python toolchain.

The one column that a plain SQL copy cannot move is `events.actions`. It holds
a pickled `EventActions`, so an event's `state_delta`, `artifact_delta`,
`escalate`, `transfer_to_agent` and requested auth configs live inside a
Python-specific binary format. `migrate()` reads that format directly. It never
runs anything the payload names: the reader hands every type reference to an
allowlist of the types `EventActions` can hold, and refuses the rest.

The source database is only read from. The destination is created if it does
not exist and is committed once at the end, so a failure part-way leaves it
empty rather than half-migrated.

## Get started

```ts
import {migrate} from '@google/adk/sessions/migration';

// A legacy adk-python database -> a database adk-js can use.
await migrate({
  sourceDbUrl: 'sqlite://./legacy_sessions.db',
  destDbUrl: 'sqlite://./sessions.db',
});
```

Then open the result as usual:

```ts
import {DatabaseSessionService} from '@google/adk';

const sessionService = new DatabaseSessionService('sqlite://./sessions.db');
const session = await sessionService.getSession({
  appName: 'demo_app',
  userId: 'demo_user',
  sessionId: 'demo_session',
});
```

A runnable end-to-end version of both steps is in
[`samples/sessions/migrate_pickle_db`](../../../../samples/sessions/migrate_pickle_db).

## Connection URLs

Both URLs accept the schemes `DatabaseSessionService` accepts: `postgres://`,
`postgresql://`, `mysql://`, `mariadb://`, `sqlite://` and `mssql://`. The
driver for each scheme is an optional peer dependency, and the error names the
package to install if it is missing.

SQLAlchemy's `dialect+driver://` spelling is accepted too, because that is the
form adk-python requires at runtime and therefore the form most users have to
hand. The driver segment is stripped before the URL is used:

```ts
await migrate({
  sourceDbUrl: 'postgresql+asyncpg://user:pw@host:5432/legacy',
  destDbUrl: 'postgresql://user:pw@host:5432/sessions',
});
```

A password in either URL is masked before it reaches a log line or an error
message.

For SQLite, everything after `sqlite://` is the file path, used exactly as
written. Write `sqlite://./sessions.db` for a path relative to the working
directory and `sqlite:///var/data/sessions.db` for an absolute one. SQLAlchemy
reads its own three-slash form as relative, so a URL copied from an adk-python
configuration resolves against the filesystem root here. Add the `./`
yourself.

## What `allowUnsafeUnpickling` does, and does not, mean

By default a pickled `actions` value may only name the types `EventActions` can
hold: the builtin containers, the stdlib data types a `state_delta` holds, the
ADK event and tool models, the auth models, and `google.genai.types`. Anything
else is refused.

```ts
await migrate({
  sourceDbUrl: 'sqlite://./legacy_sessions.db',
  destDbUrl: 'sqlite://./sessions.db',
  allowUnsafeUnpickling: true,
});
```

The flag turns that allowlist off. It is named after adk-python's flag, but it
is **not** the same hazard. In adk-python the flag hands the blob to Python's
own `pickle.loads`, which runs whatever the payload names — a real
remote-code-execution opt-in. The TypeScript reader executes nothing at any
setting: it never resolves a name to a callable, and it never calls one. With
the flag set, a value of an unrecognised type becomes a plain object of
whatever state the payload set on it.

Use it when a legitimate database holds a type the allowlist does not cover.
Reading a blob is still a copy, never an execution.

## An actions value that cannot be decoded

Losing one event's deltas is better than losing the event, so a blob that is
refused or malformed does not fail the row. The event still migrates, its
actions are empty, and the reason is reported at warning level:

```
Failed to unpickle actions for event event1: Refusing to load builtins.exec …
```

A row that has no id or no readable timestamp is skipped the same way, with a
warning, and the rest of the table still migrates.

A source table that is not there is reported at info level and skipped, which
is what happens for a v0 database that never wrote app or user state. Only the
database's own "no such table" report counts as absent. A table that exists but
cannot be read — a locked database, a permission error, a corrupt page — aborts
the migration instead, because skipping it would drop every row it holds and
still report success.

Anything else — an unreadable state column, a database that cannot be opened —
aborts the migration too. Every abort rolls the destination back.

## Differences from adk-python

- An event's timestamp is written in adk-js's unit. adk-python stores epoch
  seconds; adk-js stores epoch milliseconds. The migrated database is for
  adk-js to open, so it gets adk-js's unit. This is the v1 schema's existing
  cross-SDK difference, not one the migration introduces.
- `actions.requested_auth_configs` and `actions.requested_tool_confirmations`
  keep adk-python's field spelling, because adk-js treats both as user data and
  copies them verbatim. That is already how adk-js reads a v1 database
  adk-python wrote.
- A field adk-js does not model, such as `render_ui_widgets`, is carried
  through into `event_data` rather than dropped.
