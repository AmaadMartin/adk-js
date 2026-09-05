# DatabaseSessionService

`DatabaseSessionService` keeps sessions, events and state in a SQL database
through [MikroORM](https://mikro-orm.io/). Reach for it when sessions must
outlive the process, or when several processes share one conversation store.

## Introduction

`InMemorySessionService` loses everything when the process stops, so it suits
development and tests only. `DatabaseSessionService` implements the same
`BaseSessionService` interface against a database, so you swap the service and
leave the agent code alone.

You construct it in one of two ways. A connection string is the short path: the
service reads the scheme, loads the matching driver, and derives the connection
options for you. A MikroORM options object is the long path: you import the
driver yourself and describe the connection field by field.

The connection string used to be all-or-nothing. Any caller who wanted to tune
the connection layer, for example the pool size, had to abandon the string and
build the whole options object by hand. A second constructor argument now
carries those extra options, so you keep the string and still reach MikroORM.

Every driver is an optional peer dependency. Install the one your scheme needs
(`@mikro-orm/postgresql`, `@mikro-orm/mysql`, `@mikro-orm/mariadb`,
`@mikro-orm/mssql` or `@mikro-orm/sqlite`) alongside `@google/adk`. The service
loads it on the first `init()`, and reports a clear error when it is absent.

## Get started

The first call to any method opens the database, creates the ADK tables if they
are missing, and records the schema version.

```ts
import {DatabaseSessionService} from '@google/adk';

const sessions = new DatabaseSessionService('sqlite://./adk.db');

const session = await sessions.createSession({
  appName: 'my-app',
  userId: 'user-1',
  state: {locale: 'en-GB'},
});

const reloaded = await sessions.getSession({
  appName: 'my-app',
  userId: 'user-1',
  sessionId: session.id,
});
```

## Additional MikroORM options

The second constructor argument takes any MikroORM option and passes it to
`MikroORM.init`. It is how you size the pool, set driver-level TLS, or turn on
SQL logging without giving up the connection string.

```ts
const sessions = new DatabaseSessionService(
  'postgres://user:pass@host:5432/adk',
  {pool: {min: 2, max: 20}},
);
```

```ts
const sessions = new DatabaseSessionService('sqlite://./adk.db', {debug: true});
```

With `debug: true` MikroORM writes every statement it runs to the console. The
same service without the second argument is silent.

The second argument works with an options object too, where it supplies
defaults that the options object may override:

```ts
import {SqliteDriver} from '@mikro-orm/sqlite';

const sessions = new DatabaseSessionService(
  {dbName: ':memory:', driver: SqliteDriver, allowGlobalContext: true},
  {debug: true},
);
```

## Precedence

The first argument always wins. Three rules follow from that:

- A connection string owns `driver`, and owns `clientUrl` or `dbName`. Setting
  either of them in the second argument changes nothing.
- An options object owns every key it sets. The second argument fills in only
  the keys the options object leaves out.
- ADK owns `entities`. Neither argument can replace, extend or empty the entity
  list the service needs.

Every other key reaches MikroORM untouched. The service does not validate them;
MikroORM reports an unusable option when it opens the connection.

## Failure modes

- An options object without a `driver` throws `Driver is required when passing
options object.` from the constructor. A `driver` in the second argument does
  not satisfy that check.
- A connection string whose scheme is unsupported throws `Unsupported database
URI: <uri>` from `init()`, with the password redacted.
- A database written by an incompatible ADK schema version throws `ADK Database
schema version <version> is not compatible.` from `init()`.
