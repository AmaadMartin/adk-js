# DevServer

The HTTP server behind `adk web`. `DevServer` extends `AdkApiServer` with the
endpoints the developer UI needs, so those endpoints exist during local
development and nowhere else.

## Introduction

`AdkApiServer` serves the production surface: sessions, artifacts, and the run
endpoints. `adk api_server` starts it, and a deployment can expose it.

The developer UI needs more than that. It reads and writes recorded test
fixtures on disk, it asks for the agent graph, and it stores a telemetry
consent answer. Those endpoints write files into the agents directory, so a
production deployment must not serve them.

`DevServer` is where they live. `adk web` constructs `DevServer`; `adk
api_server` constructs `AdkApiServer`. The split is a subclass rather than a
flag, so a route registered on `DevServer` cannot reach a plain
`AdkApiServer` by accident. adk-python makes the same split between
`ApiServer` and `DevServer`.

`DevServer` does not hold every dev-facing route. `AdkApiServer` also serves
`/dev/apps/:appName/debug/trace/*` and `/dev/apps/:appName/build_graph*`, which
adk-python puts on its `DevServer`. They only read, and `adk api_server` has
served them for as long as they have existed, so they stay where they are.

Like the base class, every endpoint is unauthenticated. Bind this server to
loopback and do not expose it to an untrusted network.

## Get started

Start the server on an agents directory:

```ts
import {DevServer} from '@google/adk-devtools';

const server = new DevServer({
  agentsDir: './agents',
  host: 'localhost',
  port: 8000,
  serveDebugUI: true,
});

await server.start();
```

`adk web ./agents` does exactly this. Stop it with `await server.stop()`.

## Endpoints

| Method | Route                                | Answer                                         |
| ------ | ------------------------------------ | ---------------------------------------------- |
| GET    | `/config/telemetry`                  | `{"telemetry": true \| false \| null}`         |
| POST   | `/config/telemetry`                  | `{"telemetry": <value>}`                       |
| GET    | `/dev/apps/:appName/tests`           | Sorted `.json` file names, or `[]`             |
| PUT    | `/dev/apps/:appName/tests/:testName` | `{"status": "success", "file": "<name>.json"}` |
| GET    | `/dev/apps/:appName/tests/:testName` | The parsed file contents                       |
| DELETE | `/dev/apps/:appName/tests/:testName` | `{"status": "success"}`                        |
| GET    | `/dev/apps/:appName/graph`           | `{"dotSrc": "digraph ..."}`                    |

An error answers `{"error": "<message>"}`, the shape `AdkApiServer` already
uses.

## Test fixtures

The test endpoints read and write `<agentsDir>/<appName>/tests/*.json`. `PUT`
creates the directory when it is missing, appends the `.json` suffix when the
name lacks it, and writes the body's `session_data` field with sorted keys and
a two-space indent. A test name is reduced to its base name first, so
`../../escape.json` writes `escape.json` inside the tests directory.

`GET` and `DELETE` answer 404 with `{"error": "Test file not found"}` when the
file does not exist. Listing a missing `tests` directory answers `[]`.

## App names

An app name may nest with dots: `parent.child` resolves to
`<agentsDir>/parent/child`. Each dot-separated part must be a valid JavaScript
identifier, so a name that carries a path separator or an empty part is
rejected with 400 before any file is touched. That rule is stricter than a
directory name has to be: `my-agent` is a legal directory but not a legal app
name here, matching adk-python's identifier check.

A server built without `agentsDir` answers 500 with
`{"error": "Agents directory is not configured"}` on every route that needs a
path.

## The graph endpoint

`GET /dev/apps/:appName/graph` returns the agent graph in DOT format with no
highlights, so the UI can fetch it once and compute highlights itself.
`?dark_mode=true` draws it on the dark background; the default is light. An
app name the loader does not list answers 404, and an app that fails to load
answers 500 with its real cause.

## Telemetry consent

`POST /config/telemetry` writes the answer to `~/.adk/config.json`, the same
file adk-python uses, so both SDKs share one record on a machine that has
both. The request must carry the header `x-adk-telemetry-request: true`;
without it the server answers 400. `GET /config/telemetry` reports `null` when
no answer is recorded.
