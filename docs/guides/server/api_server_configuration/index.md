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

## Default app name

Every app-scoped route names its app: `/apps/my_agent/users/u/sessions`. Set
`ADK_DEFAULT_APP_NAME` and the server also answers the app-less form:

```console
$ ADK_DEFAULT_APP_NAME=my_agent adk web ./agents
$ curl localhost:8000/users/u/sessions
```

Three path shapes are rewritten: `/users/...`, `/app-info`, and
`/trigger/...`. Everything else is left alone, including `/list-apps`, which
is about the server rather than one app. The variable is read once, when the
server is built.

The name is not checked against the apps the loader can find. A variable
naming an app that does not exist produces the same 404 the rewritten path
would.

## Dev UI logo

`logoText` and `logoImageUrl` replace the ADK logo in the developer UI:

```console
$ adk web ./agents --logo_text Acme \
    --logo_image_url https://acme.example/logo.png
```

Both are required together. The server throws when only one is set, before it
binds a port. They are `adk web` options only, because `adk api_server` serves
no UI.

The UI reads them from two places. The server writes
`assets/config/runtime-config.json` under the directory it serves the UI
bundle from, so the values are there when the page loads, and it answers
`GET /dev-ui/config` with them as well. Keys the shipped
`runtime-config.json` already holds are preserved, and the `logo` key is
removed when neither option is set. The same file carries `backendUrl`, from
`urlPrefix`, and the telemetry consent the ADK CLI recorded.

A write failure is reported at error level and does not stop the server. The
UI then falls back to its built-in defaults.

## Default LLM model

`defaultLlmModel` is the model an agent falls back to when it sets none:

```console
$ adk web ./agents --default_llm_model gemini-2.5-flash
```

It is applied through `LlmAgent.setDefaultModel`, which holds the model
process-wide. It therefore reaches every agent in the process, not only the
ones this server serves.
