# createApiServer

Builds a configured ADK API server from plain options: directories, service
URIs and flags in, a ready server or Express application out. Reach for it
when you want the surface `adk web` and `adk api_server` serve, but from your
own process instead of the command line.

## Introduction

`AdkApiServer` takes services, not configuration. It expects a
`BaseSessionService`, a `BaseArtifactService` and a `BaseMemoryService` that
somebody already built. Turning `postgresql://...` or `gs://my-bucket` into
those objects, choosing the defaults, and deciding what telemetry does is a
separate job, and until now it lived inside the CLI command handlers where no
other caller could reach it.

`createApiServer` is that job, extracted. It resolves each service from its
URI, applies the same defaults the CLI applies, and returns the server. The
CLI now calls it too, so an embedded server and `adk api_server` are wired the
same way and cannot drift apart.

`createApiServerApp` goes one step further and returns the initialised
Express application. Nothing is listening: you mount it on a server you
create, next to your own routes and middleware. This is the counterpart of
adk-python's `get_fast_api_app`.

Choose between them by who owns the socket. If the ADK server owns it, use
`createApiServer` and call `start()`. If your process already has an HTTP
server, use `createApiServerApp`.

## Get started

Serve the ADK API from a listener you own:

```ts
import {createApiServerApp} from '@google/adk-devtools';
import * as http from 'node:http';

const app = await createApiServerApp({
  agentsDir: './agents',
  web: false,
  port: 8080,
});

http.createServer(app).listen(8080);
```

Or let the server own the socket, which is what `adk web` does:

```ts
import {createApiServer} from '@google/adk-devtools';

const server = createApiServer({
  agentsDir: './agents',
  web: true,
  port: 8000,
});

await server.start();
```

`web` decides what is mounted. With `web: false` you get the API endpoints and
`GET /health`. With `web: true` you also get the dev UI, and `GET /` redirects
to `/dev-ui`.

## Services

Each service is named by a URI, and an unsupported one throws:

| Option               | Supported values                              | Default                          |
| -------------------- | --------------------------------------------- | -------------------------------- |
| `sessionServiceUri`  | `memory://`, a database URL, `vertexai://...` | `DATABASE_URL`, then `memory://` |
| `artifactServiceUri` | `memory://`, `gs://<bucket>`, `file://<dir>`  | `memory://`                      |
| `memoryServiceUri`   | `memory://`                                   | `memory://`                      |

```ts
const server = createApiServer({
  agentsDir: './agents',
  web: false,
  sessionServiceUri: 'postgresql://user:pass@host/db',
  artifactServiceUri: 'gs://my-bucket',
});
```

An error message names the scheme and never the credentials the URI carries.

Pass `agentLoader` to serve agents that are already in the process, rather
than files under `agentsDir`.

## Network

`host` is the address the server binds, and the address the A2A agent card
advertises. `bindHost` overrides the first without touching the second, for a
server behind a proxy.

A server bound to loopback rejects a request whose `Host` header names
anything else, which is what stops a DNS-rebinding page from reaching it.
`allowOrigins` vouches for the host of each origin it lists, and
`allowedHosts` vouches for a host directly. `allowOrigins` also configures
CORS, and accepts one origin or a list:

```ts
const app = await createApiServerApp({
  agentsDir: './agents',
  web: false,
  bindHost: '0.0.0.0',
  allowOrigins: ['https://console.example', 'https://ops.example'],
});
```

## Agent-to-Agent

`a2a: true` mounts an A2A surface for every agent under `/a2a/<app>/`. Set
`a2aAuthToken` (or the `ADK_A2A_AUTH_TOKEN` environment variable) to
authenticate it; without a token the surface is served unauthenticated, which
is a local-development setting.

The agent card is built from the configured `host` and `port`, so serve the
app on those.

## Telemetry

`otelToCloud: true` exports OpenTelemetry traces and metrics to Google Cloud.

`traceToCloud: true` asks for the same thing conditionally: it reads
`<agentsDir>/.env`, and exports only when `GOOGLE_CLOUD_PROJECT` is set. When
it is not, the factory reports that tracing stays off and the server keeps
telemetry local.
