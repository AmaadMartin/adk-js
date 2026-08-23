# Service registry

The registry maps a URI scheme to the code that builds a session, artifact or
memory service. Reach for it when `adk web`, `adk api_server` or `adk run` must
talk to a backend ADK does not ship.

## Introduction

The three CLI commands take a service URI per service kind:
`--session_service_uri`, `--artifact_service_uri` and `--memory_service_uri`.
Each URI names a backend by its scheme. `postgres://…` selects
`DatabaseSessionService`, `gs://my-bucket` selects `GcsArtifactService`, and
`memory://` selects the in-memory service.

Before the registry, that list of schemes was fixed in ADK's own source. A team
with a session store of its own had no way in: the CLI rejected the URI, and the
only route was to fork ADK or to stop using the CLI. The registry turns the list
into a table you can add to. A scheme you register is a peer of a built-in one,
resolved by the same lookup, so `--session_service_uri mysession://host/db`
works the moment `mysession` has a factory.

The registry is process-wide and is read when a URI is resolved, not when a
module is imported. The CLI reads the agent directory first, then builds the
services, so a registration made at start-up is visible. Registering a scheme
that already exists replaces it, which is how you override a built-in.

There are two ways to register. A `services.yaml` names a class for ADK to
construct, and needs no code. A `services.{ts,js}` module exports factory
functions, and suits a backend that needs more than a URI to build. ADK reads
the config first, so the module wins a scheme both declare.

## Get started

Write the backend as a class whose constructor takes the URI. The example below
keeps the in-memory behaviour and only records where it would connect, so it
runs as written.

```ts
// my_agents/my_session_service.ts
import {InMemorySessionService} from '@google/adk';

export class MySessionService extends InMemorySessionService {
  constructor(readonly uri: string) {
    super();
  }
}
```

Declare it in `my_agents/services.yaml`:

```yaml
services:
  - scheme: mysession
    type: session
    module: ./my_session_service.ts
    class: MySessionService
```

Then start the server against that scheme:

```
adk api_server ./my_agents --session_service_uri mysession://host/db
```

ADK constructs `new MySessionService('mysession://host/db')` and uses it for
every session in that server.

## The services.yaml format

`services` is a list. Each entry has four keys:

| Key      | Required | Meaning                                                       |
| -------- | -------- | ------------------------------------------------------------- |
| `scheme` | yes      | The URI scheme this entry serves, matched case-insensitively. |
| `type`   | yes      | `session`, `artifact` or `memory`.                            |
| `module` | yes      | A module specifier, resolved from the agent directory.        |
| `class`  | no       | The export to construct. Defaults to the default export.      |

`module` is resolved from the agent directory, so `./backends/mine.js` points
inside it and `my-backend-package` comes from its `node_modules`. A TypeScript
source is compiled first, the same way ADK compiles an agent file.

`module` names the file on disk. Give a TypeScript source its real extension,
`./backends/mine.ts`, and not the `./backends/mine.js` a TypeScript `import`
would write for it. ADK resolves this key through Node, which has no rule that
maps `.js` back to `.ts`. An entry ADK cannot resolve is reported and skipped,
so the symptom is a start-up warning and then `Unsupported session service URI`
when the scheme is used.

ADK reads `services.yaml` and then `services.yml`, so both take effect when both
exist. A malformed entry is reported and skipped, and its valid siblings still
register. A file ADK cannot parse stops the whole directory, which leaves the
built-in schemes in place rather than a half-applied configuration.

This is the one place adk-js and adk-python differ. Python writes a single
dotted `class` key, `my_pkg.my_module.MyService`. That has no JavaScript
meaning, so the module specifier and the export name are two keys here.

## The services module

A `services.ts`, `services.js`, `services.mjs` or `services.cjs` in the agent
directory can export the factories instead. Use it when building the backend
takes more than a constructor call: reading a secret, sharing one connection
pool across schemes, or choosing a class at run time.

```ts
// my_agents/services.ts
import {ServiceRegistrations} from '@google/adk';
import {MySessionService} from './my_session_service.js';

export const services: ServiceRegistrations = {
  session: {
    mysession: (uri) => new MySessionService(uri),
  },
};
```

The module exports a registrations object rather than calling the registry
itself. ADK compiles the module separately, so it can hold its own copy of
`@google/adk`; a call to `getServiceRegistry()` from inside it would reach a
second registry and the registration would vanish.

## Registering from your own code

An embedding application that builds its own `Runner` can register directly:

```ts
import {getServiceRegistry, getSessionServiceFromUri} from '@google/adk';
import {MySessionService} from './my_session_service.js';

getServiceRegistry().registerSessionService(
  'mysession',
  (uri) => new MySessionService(uri),
);

const sessionService = getSessionServiceFromUri('mysession://host/db');
```

## Built-in schemes

| Kind     | Schemes                                                                               |
| -------- | ------------------------------------------------------------------------------------- |
| session  | `memory`, `postgres`, `postgresql`, `mysql`, `mariadb`, `mssql`, `sqlite`, `vertexai` |
| artifact | `memory`, `gs`, `file`                                                                |
| memory   | `memory`, `agentengine`                                                               |

Each kind has its own scheme table. A `mysession` session factory is invisible
to an artifact or memory lookup, so the same scheme name can mean a different
thing per kind.

## Failure modes

`getSessionServiceFromUri`, `getArtifactServiceFromUri` and
`getMemoryServiceFromUri` throw when no factory owns the URI's scheme. The
message carries the URI with its password removed.

Discovery never stops the CLI. A missing file, an unparseable file, a module
that throws, and an entry naming a class the module does not export are all
reported and skipped, and the server starts with the schemes that did register.
A factory that throws when ADK calls it is a different case: that error reaches
the CLI and start-up fails.

Both discovery forms run code from the agent directory when the CLI starts.
That is the trust level the CLI already grants the agent file itself. Neither
form is sandboxed.
