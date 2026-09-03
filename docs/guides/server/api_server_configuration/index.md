# Configuring the ADK API server

`AdkApiServer` serves the HTTP API that `adk web` and `adk api_server` start.
This guide covers the three options that decide where it keeps tool
credentials, how it answers a request naming a session that does not exist,
and what path it puts in the redirects it generates.

## Introduction

The server is a thin layer over `Runner`. It loads an agent, builds one
`Runner` per app, and drives that runner from the HTTP endpoints. Each option
below has a default that matches what the server did before the option
existed, so adding none of them changes no response.

`credentialService` decides where a tool keeps a credential it obtained
through an auth exchange. The credential has nowhere to live between requests
without one, so the tool repeats the exchange on every request.

`autoCreateSession` decides what `POST /run` and `POST /run_sse` do when the
request names a session that does not exist. The default answers 404, so a
client that picks its own session id must create the session first.

`urlPrefix` decides the path the server puts in the redirects it generates. It
moves no route. Use it when a reverse proxy strips a prefix before the request
reaches the server.

## Get started

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  port: 8000,
  serveDebugUI: true,
  autoCreateSession: true,
  urlPrefix: '/adk',
});

await server.start();
```

Two of the options are also command-line flags:

```console
$ adk api_server ./agents --auto_create_session --url_prefix /adk
$ adk web ./agents --url_prefix /adk
```

`--url_prefix` is on both commands. `--auto_create_session` is on `api_server`
only.

## Credential service

Every `Runner` the server builds shares one credential service. The default is
an `InMemoryCredentialService`, which holds a credential per app and user for
as long as the process runs. Supply your own to store them elsewhere:

```ts
import {InMemoryCredentialService} from '@google/adk';
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  credentialService: new InMemoryCredentialService(),
});
```

This option has no command-line flag. The credentials the default service
holds are process-local, and they are lost when the server stops. Do not log
them.

## Automatic session creation

With `autoCreateSession`, `POST /run` and `POST /run_sse` create the session
the request names:

```console
$ curl -XPOST localhost:8000/run -H 'content-type: application/json' \
    -d '{"appName":"echo","userId":"u","sessionId":"fresh",
         "newMessage":{"role":"user","parts":[{"text":"hi"}]}}'
```

The answer is 200 with the run's events, and
`GET /apps/echo/users/u/sessions/fresh` then returns the new session. The
server creates it empty, with no state.

Without the option both endpoints answer 404 and name the session:

```json
{"error": "Session not found: fresh"}
```

A session that already exists is used as before, with or without the option.

## URL prefix

`urlPrefix` applies to the redirects the server generates, and to nothing
else. With `serveDebugUI` on, `GET /` redirects to the developer UI:

| `urlPrefix` | `Location`    |
| ----------- | ------------- |
| unset       | `/dev-ui`     |
| `/adk`      | `/adk/dev-ui` |

Routes stay at the root, so the proxy must strip the prefix before it forwards
a request. The server accepts a value written without its leading slash
(`adk`) and normalizes it to `/adk`, and it removes a trailing slash. It
rejects nothing, which matches adk-python.

The A2A agent card is not rewritten with the prefix.
