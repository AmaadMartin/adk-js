# Service registry

The service registry maps a URI scheme to a session, artifact or memory backend
of your own. Reach for it when `--session_service_uri` or
`--artifact_service_uri` must name a store the ADK does not ship with, such as
Redis or a house database.

## Introduction

`adk run`, `adk web` and `adk api_server` build their services from a URI.
`@google/adk` resolves the schemes it ships with: `memory://`, a database URL,
`gs://` for Cloud Storage and `file://` for local files. Any other scheme is an
error, so a Redis-backed store had no way in.

The registry is that way in. It lives in the CLI package, and the CLI reads it
before the built-in resolver, so a scheme you register wins over a built-in of
the same name. The declarations are read from the agent's own directory: the
directory holding the agent file for `adk run`, and the agents directory for
`adk web` and `adk api_server`.

Two files are read, in this order.

| File                                   | Use it when                                |
| -------------------------------------- | ------------------------------------------ |
| `services.yaml` or `services.yml`      | The class can be built from the URI alone. |
| `services.ts`, `.js`, `.mjs` or `.cjs` | The constructor needs more than the URI.   |

Both may be present. The script is applied second, so it replaces a scheme the
YAML declared.

The registry serves three kinds: `session`, `artifact` and `memory`. The CLI
reads the session and artifact kinds, because they are the two it has options
for. A memory backend registers the same way and is read through
`getServiceRegistry()` from your own code, since there is no
`--memory_service_uri` option yet.

## Get started

Declare the backend in `services.yaml`, beside the agent.

```yaml
services:
  - scheme: redis
    type: session
    class: '@acme/adk-redis#RedisSessionService'
```

Then name the scheme on the command line.

```shell
adk run agent.ts --session_service_uri redis://localhost:6379
```

The `class` field is a module specifier, a `#`, and the name of the export.
With no `#`, the default export is used. A specifier starting with `.` names a
file beside the YAML, spelled as it is on disk, so a TypeScript neighbour is
`./redis_session_service.ts`. Anything else is a package name. The class is
built as `new Class({uri})`, with the whole URI, and it is imported while the
YAML is read, so a name that cannot be resolved is reported at once.

## Registering from a script

Use a script when the constructor needs more than the URI.

```ts
import {getServiceRegistry} from '@google/adk-devtools';

import {RedisSessionService} from './redis_session_service.js';

getServiceRegistry().registerSessionService(
  'redis',
  (uri) => new RedisSessionService({url: uri, poolSize: 8}),
);
```

A factory may be asynchronous; the CLI awaits it. `registerArtifactService` and
`registerMemoryService` take the same pair of arguments. Registering a scheme
twice replaces the first factory, and the schemes of one kind are separate from
the schemes of another: `redis` as a session backend does not make `redis://`
resolve as an artifact backend.

A TypeScript script is compiled before it is imported. Its relative imports are
bundled into it, and its package imports are left alone, so the
`@google/adk-devtools` it imports is the one the CLI is running.

## Failure modes

The registry never stops the CLI. A declaration it cannot use is reported and
skipped, so a mistake in `services.yaml` does not make the agent unrunnable.

| What happened                                            | What the CLI does                      |
| -------------------------------------------------------- | -------------------------------------- |
| The directory does not exist                             | Nothing, at debug level.               |
| No `services.*` file                                     | Nothing.                               |
| The YAML cannot be parsed, or a class cannot be imported | Warns, and does not read the script.   |
| An entry omits `scheme`, `type` or `class`               | Warns and moves to the next entry.     |
| An entry names a `type` that is not a kind               | Warns and moves to the next entry.     |
| The script throws                                        | Warns, and the run continues.          |
| No factory claims the scheme                             | The built-in resolver handles the URI. |

The script runs whatever code it contains. That is what makes it useful, and it
means the agent directory has to be as trusted as the agent itself.
