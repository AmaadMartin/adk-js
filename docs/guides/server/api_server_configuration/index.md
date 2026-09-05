# API server configuration

`AdkApiServer` serves every agent under an agents directory. Four options adapt
it to a deployment: a default app name, a dev UI logo, a URL prefix, and extra
plugins. Reach for them when the server runs behind a fixed URL, carries your
branding, or has to load a plugin that no agent file declares.

## Introduction

The server addresses an agent by name. Every production route carries the name
in its path — `/apps/<app>/users/<user>/sessions/<session>` — and `/run` reads
it from the request body. That is right for a machine hosting several agents.
It is noise for a deployment that hosts one, where every client repeats the same
constant in every URL.

The options here remove that repetition and adapt the surface to an operator's
environment. They are independent of each other and every one is optional: a
server started without them behaves as it did before they existed.

The logo and the URL prefix reach the dev UI two ways: through
`GET /dev-ui/config`, and through `assets/config/runtime-config.json`, which the
server writes into the web assets directory at start-up.

## Get started

Start a server for one agent and let clients drop its name:

```bash
ADK_DEFAULT_APP_NAME=my_agent npx adk api_server ./agents
```

```bash
# Both of these reach my_agent.
curl localhost:8000/users/u1/sessions/s1
curl -XPOST localhost:8000/run -H 'Content-Type: application/json' \
  -d '{"userId":"u1","sessionId":"s1","newMessage":{"role":"user","parts":[{"text":"Hi"}]}}'
```

The same options are available when you build the server yourself:

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  serveDebugUI: true,
  logoText: 'Acme',
  logoImageUrl: 'https://acme.example/logo.svg',
  extraPlugins: ['./plugins/audit.js.AuditPlugin'],
  urlPrefix: '/adk',
});

await server.start();
```

## Default app name

Set `ADK_DEFAULT_APP_NAME` in the server's environment. There is no constructor
option and no flag: the server reads the variable when it is built.

Three request paths then resolve against that app, and nothing else does:
`/users/...`, `/app-info` and `/trigger/...` each become `/apps/<default>/...`.
`/app-info` is matched whole, so `/app-info/extra` is left alone, and the access
log still records the path the client sent.

`POST /run` and `POST /run_sse` fall back to the default when the body names no
`appName`. Without a default they answer `400` with
`app_name is required when ADK_DEFAULT_APP_NAME is not set`.

## Dev UI logo

`logoText` and `logoImageUrl` go together. Setting one alone makes `start()`
reject, so a half-configured logo fails at start-up rather than later.

The dev UI reads the pair from `GET /dev-ui/config`, which always answers with
both keys and uses `null` for one that is unset:

```json
{"logo_text": "Acme", "logo_image_url": "https://acme.example/logo.svg"}
```

The keys are snake_case because the dev UI reads them by name.

## runtime-config.json

In dev UI mode the server merges its configuration into
`<webAssetsDir>/assets/config/runtime-config.json` at start-up:

```json
{
  "backendUrl": "/adk",
  "telemetry": true,
  "logo": {"text": "Acme", "imageUrl": "https://acme.example/logo.svg"}
}
```

`backendUrl` is `urlPrefix`, or `""` when there is none. Routes stay at the
root; the prefix only tells the UI where to send its requests. `telemetry` is
the consent recorded in `~/.adk/config.json`, and is `null` when the user has
answered neither way.

Keys the file already holds are preserved. `logo` is the exception: it is
removed when no logo is configured, which is how you turn one off. Nothing is
written when the web assets are absent, and a write that fails is logged and
does not stop the server.

## Extra plugins

`extraPlugins` names plugins by `<module>.<export>`, split on the last `.`. The
server imports each one at start-up and adds it to every runner, alongside the
plugins an app declares itself:

```bash
npx adk web ./agents --extra_plugins ./plugins/audit.js.AuditPlugin
```

A relative or absolute module resolves against the directory the server was
started in. Anything else is treated as a package specifier. The module part is
handed to `import()` as it is, so a file path needs its extension —
`./plugins/audit.js.AuditPlugin`, not `./plugins/audit.AuditPlugin`.

The export may be a plugin class or a ready-made plugin instance. A class is
constructed with the qualified name it was named by, so the plugin above is
named `./plugins/audit.js.AuditPlugin`.

A name that cannot be imported, is not exported by its module, or is not a
plugin is logged at error level and skipped. One bad name stops neither the
other plugins nor the server.

This runs code the operator named, so keep those names in server configuration.
No route reaches the loader, and none should.

## Divergences from adk-python

- The flags are `--logo_text` and `--logo_image_url`, underscored to match
  every other adk-js flag. adk-python spells them with hyphens.
- adk-js accepts the logo flags on `api_server` too, where they have no effect,
  because both commands share one server class.
- The plugins are loaded once per server and shared by every runner. adk-python
  instantiates them per runner.
