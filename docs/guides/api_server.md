# createApiServer

Builds a configured ADK API server from plain options: a directory, service
URIs and flags in, a ready server or Express application out. Reach for it
when you want the surface `adk web` and `adk api_server` serve, but from your
own process instead of the command line.

## Introduction

`AdkApiServer` takes services, not configuration. It expects a
`BaseSessionService` and a `BaseArtifactService` that somebody already built.
Turning `postgresql://...` or `gs://my-bucket` into those objects, choosing
the defaults, and deciding what telemetry does is a separate job, and until
now it lived inside the CLI command handlers where no other caller could
reach it.

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

http.createServer(app).listen(8080, 'localhost');
```

The listener binds `localhost` because `host` defaults to `localhost`, and a
loopback host arms the DNS-rebinding guard: the app then answers only a
request whose `Host` header is loopback. Serving it on another address takes
one more option, described under [Network](#network).

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

`sessionServiceUri` accepts `memory://`, a database URL, or `vertexai://...`,
and defaults to the `DATABASE_URL` environment variable, then to `memory://`.
`artifactServiceUri` accepts `memory://`, `gs://<bucket>` or `file://<dir>`,
and defaults to `memory://`. An unsupported URI throws, and the message
redacts the password the URI carries.

Pass `agentLoader` to serve agents that are already in the process, rather
than files under `agentsDir`.

## Network

`host` is the address the server binds. It is also the address the
DNS-rebinding guard measures, and the host the A2A agent card advertises, so
you cannot advertise one address and bind another.

A server bound to loopback rejects a request whose `Host` header names
anything else, which is what stops a DNS-rebinding page from reaching it.
`allowOrigins` vouches for the host of each origin it lists, and
`allowedHosts` vouches for a host directly. `allowOrigins` also configures
CORS, and accepts one origin or a list:

```ts
const app = await createApiServerApp({
  agentsDir: './agents',
  web: false,
  host: '0.0.0.0',
  allowOrigins: ['https://console.example', 'https://ops.example'],
});
```

## Agent-to-Agent

`a2a: true` mounts an A2A surface for every agent under `/a2a/<app>/`. Set
`a2aAuthToken` (or the `ADK_A2A_AUTH_TOKEN` environment variable) to
authenticate it; without a token the surface is served unauthenticated, which
is a local-development setting.

The agent card advertises the configured `host` and `port`, so serve the app
on those. A client cannot reach the card's URL if you serve the app somewhere
else, behind a proxy for instance.

## Telemetry

`otelToCloud: true` exports OpenTelemetry traces and metrics to Google Cloud.

`traceToCloud: true` asks for the same thing conditionally: it reads
`<agentsDir>/.env`, and exports only when `GOOGLE_CLOUD_PROJECT` is set. When
it is not, the factory reports that tracing stays off and the server keeps
telemetry local.
