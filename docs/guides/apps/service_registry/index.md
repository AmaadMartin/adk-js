# ServiceRegistry

`ServiceRegistry` maps a URI scheme to the session, artifact or memory service
that serves it. The ADK CLI consults it before its built-in resolvers, so `adk
web`, `adk api_server` and `adk run` can reach a backend ADK does not ship
with. Reach for it when you want `--session_service_uri myscheme://…` to build
your own service.

## Introduction

The CLI takes a service URI on the command line, and until now the set of
schemes it understood was fixed: `memory://`, a database URL, `gs://`,
`file://`. A team with a Redis session store or an internal artifact bucket had
no way to name it.

The registry turns that fixed set into a lookup. Each scheme is bound to a
factory, and the factory receives the whole URI plus the agent directory, so it
can parse whatever it needs out of the string. ADK seeds the registry with its
own backends on first use; anything you register joins the same table and is
resolved the same way. A scheme nobody claims falls through to the CLI's
existing resolver unchanged, so every URI that worked before still works.

There are two ways to add a scheme, and both live next to the agent rather than
in ADK. Declare it in `services.yaml` when `new MyService({uri})` is enough.
Write `services.js` when construction needs real logic. Both files may be
present: the YAML file is processed first, so a scheme declared in both ends up
bound to the factory `services.js` registers.

## Get started

Put a `services.yaml` beside your agent naming the class to build:

```yaml
services:
  - scheme: demo
    type: session
    class: './demo_session_service.js#DemoSessionService'
```

`type` is one of `session`, `artifact` or `memory`. `class` is a
module specifier, a `#`, and the export name; the export name defaults to
`default`. A relative specifier resolves against the agent directory.

The class receives one options object:

```js
import {InMemorySessionService} from '@google/adk';

export class DemoSessionService extends InMemorySessionService {
  constructor({uri}) {
    super();
    this.uri = uri;
  }
}
```

Then name the scheme on the command line. `--session_service_uri`,
`--artifact_service_uri` and `--memory_service_uri` all resolve through the
registry:

```bash
npx adk run my_agent/agent.ts --session_service_uri demo://local
```

A runnable version of this example is in
[`samples/service_registry/`](../../../../samples/service_registry/).

## Registering from JavaScript

When the backend needs more than a constructor call, write `services.js` in the
agent directory. ADK imports it for its side effects after the YAML file:

```js
import {getServiceRegistry} from '@google/adk-devtools';
import {DemoSessionService} from './demo_session_service.js';

getServiceRegistry().registerSessionService(
  'demo',
  (uri) => new DemoSessionService({uri}),
);
```

`getServiceRegistry()` returns one registry for the whole process, so a
registration made here is visible everywhere. Registering a scheme twice
replaces the previous factory.

## Using the registry directly

Outside the CLI, build the services yourself:

```ts
import {getServiceRegistry, loadServicesModule} from '@google/adk-devtools';

await loadServicesModule('/path/to/my_agent');
const sessionService = getServiceRegistry().createSessionService(
  'demo://local',
  {agentsDir: '/path/to/my_agent'},
);
```

`createSessionService`, `createArtifactService` and `createMemoryService`
return `undefined` when no factory claims the scheme, which is how a caller
tells "not my scheme, fall back" from "your URI is broken". The CLI falls back
to its own resolver for a session or artifact URI, and refuses a memory URI,
which has no fallback resolver.

Pass `agentsDir` when you can. Factories that need a Google Cloud project and
location read `<agentsDir>/.env` before the ambient environment.

## Built-in schemes

| Service type | Scheme                      | Builds                                                                                |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------- |
| session      | `memory://`                 | `InMemorySessionService`                                                              |
| session      | `sqlite://`                 | `InMemorySessionService` when the URI has no path, otherwise `DatabaseSessionService` |
| session      | `postgresql://`, `mysql://` | `DatabaseSessionService`                                                              |
| session      | `agentengine://`            | `VertexAiSessionService`                                                              |
| artifact     | `memory://`                 | `InMemoryArtifactService`                                                             |
| artifact     | `gs://`                     | `GcsArtifactService`, bucket taken from the authority                                 |
| artifact     | `file://`                   | `FileArtifactService`, local paths only                                               |
| memory       | `memory://`                 | `InMemoryMemoryService`                                                               |
| memory       | `agentengine://`            | `VertexAiMemoryBankService`                                                           |

`agentengine://` accepts a bare id (`agentengine://123`, which needs
`agentsDir` and `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`) or a full
resource name
(`agentengine://projects/p/locations/l/reasoningEngines/123`).

A built-in factory takes only the URI and the agent directory. Register your own
factory for the scheme when a backend needs more than that.

## What a declared class may name

A configuration file may name code. It may not carry code. ADK refuses a
`class` specifier that names a Node built-in module, and one that carries its
own URL scheme such as `data:`. A relative specifier resolves against the agent
directory, so a Windows drive letter is never read as a URL scheme.

ADK also checks what the class builds. A class declared as a `session` service
that does not implement the session methods raises an error naming the class,
rather than failing later inside the runner.

## Failure handling

`loadServicesModule` never throws. It logs a warning and moves on, because a
broken services file should not stop the CLI from starting:

- The directory does not exist: nothing is loaded.
- `services.yaml` fails to parse or a declared class fails to import: the
  loader warns and **stops**. It does not go on to `services.js`, so a
  half-registered directory is never silently completed.
- A YAML entry missing `scheme`, `type` or `class`: the entry is skipped and
  the rest of the file is processed.
- A YAML entry with an unknown `type`: nothing is registered for it.
- `services.js` throws: the loader warns and continues.
