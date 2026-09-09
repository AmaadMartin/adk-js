# Service registry

`adk run` builds its session and artifact services from a URI. The service
registry lets an agent add a URI scheme of its own, so a run can store sessions
or artifacts in a backend that ADK does not ship.

## Introduction

`--session_service_uri` and `--artifact_service_uri` accept a fixed set of
schemes. Sessions accept `memory://`, `vertexai://` and the database URLs
(`postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `mssql://`,
`sqlite://`). Artifacts accept `memory://`, `gs://` and `file://`. Any other
scheme fails with `Unsupported session service URI`.

The registry closes that gap without a change to ADK. You declare the scheme in
a file beside the agent, and `adk run` reads that file before it builds any
service. A registered scheme wins over the built-in resolver, so an agent can
also replace a scheme ADK already serves.

Only `adk run` reads the file. `adk web` and `adk api_server` keep the built-in
schemes.

## Get started

Write a class that implements `BaseSessionService` or `BaseArtifactService`.
Its constructor takes the whole URI, so the class decides what the part after
the scheme means.

Declare the class in `services.yaml`, in the directory that holds the agent
file:

```yaml
services:
  - scheme: mysession
    type: session
    module: ./my_session_service.js
    export: MySessionService
```

Then name the scheme on the command line:

```
adk run ./agent.ts --session_service_uri mysession://demo
```

`adk run` constructs `MySessionService('mysession://demo')` and gives it to the
runner.

## The YAML file

`services.yaml` (or `services.yml`) holds one entry per scheme:

| Field    | Required | Meaning                                                     |
| -------- | -------- | ----------------------------------------------------------- |
| `scheme` | yes      | The URI scheme this backend serves.                         |
| `type`   | yes      | `session` or `artifact`.                                    |
| `module` | yes      | Path of the module, resolved against the agent directory.   |
| `export` | no       | Name of the exported class. Defaults to the default export. |

## The services module

A backend that needs more than a constructor call is declared in `services.ts`
(or `.js`, `.mjs`, `.cjs`) instead. The module exports the registrations, and
each one carries its own factory:

```ts
// services.ts
import {MySessionService} from './my_session_service.js';

export const services = [
  {
    scheme: 'mysession',
    type: 'session',
    create: (uri: string) => new MySessionService(uri, {readOnly: true}),
  },
];
```

ADK reads the named export `services`, or the default export when there is no
`services`. A TypeScript module is compiled before it is imported. Packages
stay external, so your module and the CLI share one copy of `@google/adk`.

adk-python's `services.py` mutates a registry singleton instead. A compiled or
bundled JavaScript module can hold a second copy of the devtools package, whose
singleton nothing reads, so the JavaScript spelling exports a list.

## Failure modes

Loading never stops a run. Every problem below is logged as a warning, and
`adk run` continues:

- The agent directory holds no services file. Nothing is registered.
- The YAML file cannot be parsed. Loading stops, and the services module is
  **not** read.
- An entry has no `scheme` or no `module`, or names a `type` other than
  `session` or `artifact`. That entry is skipped, and its siblings still
  register.
- A module cannot be imported, or does not export the name the entry gives.
  That entry is skipped.

One failure is reported later, when the scheme is used. A class that does not
implement the service it claims makes the run fail with
`<module> did not produce a session service`.
