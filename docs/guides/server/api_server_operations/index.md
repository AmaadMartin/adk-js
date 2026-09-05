# Configuring the ADK API server

`AdkApiServer` serves your agents over HTTP. Three options change how it runs
without changing your agents: `extraPlugins` attaches plugins to every runner,
`ADK_DEFAULT_APP_NAME` lets clients omit the app name from a path, and the logo
pair brands the dev UI. Reach for them when you deploy the server rather than
when you write an agent.

## Introduction

An operator and an agent author want different things from the server. The
agent author decides what an agent does, and puts plugins on the `App` that
needs them. The operator decides how one deployment behaves: which audit or
metrics plugin runs for every app, whether the deployment serves one agent or
many, and what the dev UI is called. These options belong to the operator, so
they live on the server and on the `adk web` / `adk api_server` command lines
rather than in agent code.

Each one is independent and off by default. With none of them set the server
answers exactly as it did before.

- `extraPlugins` loads plugins by name and hands them to every `Runner` the
  server builds. The `Runner` merges them with the plugins the `App` already
  declares, so an app's own plugins keep working.
- `ADK_DEFAULT_APP_NAME` names the app that serves a request which carries no
  app name. It suits a single-app deployment, where repeating `/apps/<name>` in
  every path buys nothing.
- `logoText` and `logoImageUrl` brand the dev UI. They also land in
  `runtime-config.json`, which the dev UI reads at boot.

## Get started

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  serveDebugUI: true,
  extraPlugins: ['./plugins/audit_plugin.js#AuditPlugin'],
  logoText: 'Acme Agents',
  logoImageUrl: 'https://example.com/acme.svg',
});

await server.start();
```

The same options are available on the command line:

```console
$ adk web ./agents \
    --extra_plugins ./plugins/audit_plugin.js#AuditPlugin \
    --logo-text 'Acme Agents' \
    --logo-image-url https://example.com/acme.svg
```

## Loading extra plugins

Name each plugin as `<module>#<export>`. The module half is anything Node can
import; the export half names the value to read from it.

| Specifier                        | What it loads                                          |
| -------------------------------- | ------------------------------------------------------ |
| `./plugins/audit.js#AuditPlugin` | The `AuditPlugin` export of a file next to your agents |
| `@acme/adk-audit#AuditPlugin`    | The `AuditPlugin` export of an installed package       |
| `./plugins/audit.js`             | The module's default export                            |

A relative or absolute module path resolves against `agentsDir`. A bare package
specifier goes to Node's module resolver unchanged, so it resolves from where
ADK is installed.

The export may be a class or an already-built instance. A class is constructed
with the specifier as the plugin name:

```ts
import {BasePlugin, InvocationContext} from '@google/adk';

const auditLog: string[] = [];

export class AuditPlugin extends BasePlugin {
  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    // `this.name` is './plugins/audit.js#AuditPlugin' here.
    auditLog.push(`${this.name}: ${invocationContext.invocationId}`);
    return undefined;
  }
}

// Export an instance instead when you want to choose the name yourself.
export const auditPlugin = new AuditPlugin('audit');
```

On the command line, separate several plugins with commas:

```console
$ adk api_server ./agents --extra_plugins ./plugins/audit.js#AuditPlugin,@acme/adk-metrics#MetricsPlugin
```

The server loads the plugins once and shares them across every app it serves.
A plugin that holds per-app state will therefore see every app.

A specifier that cannot be imported, or that names something which is not a
plugin, is reported at error level and skipped. The server still starts and the
other plugins still load.

## Serving one app without naming it

Set `ADK_DEFAULT_APP_NAME` and the server serves three path shapes as if they
began with `/apps/<name>`:

| Client path             | Served as                             |
| ----------------------- | ------------------------------------- |
| `/users/u1/sessions/s1` | `/apps/my_agent/users/u1/sessions/s1` |
| `/app-info`             | `/apps/my_agent/app-info`             |
| `/trigger/...`          | `/apps/my_agent/trigger/...`          |

```console
$ ADK_DEFAULT_APP_NAME=my_agent adk api_server ./agents
$ curl localhost:8000/users/u1/sessions/s1
```

Query strings survive the rewrite, and a path that already names an app is left
alone. Nothing else is rewritten, so `/list-apps` and `/apps/other/...` behave
as they always did.

`POST /run` and `POST /run_sse` accept the same omission: leave `appName` out of
the body and the default app runs. An `appName` in the body always wins over the
environment variable. With neither, both endpoints answer:

```json
{"error": "app_name is required when ADK_DEFAULT_APP_NAME is not set"}
```

with status `400`.

The server reads `ADK_DEFAULT_APP_NAME` when you construct it, so changing
`process.env` afterwards has no effect.

## Branding the dev UI

`logoText` and `logoImageUrl` go together. Setting one without the other makes
`start()` reject with:

```
Both --logo-text and --logo-image-url must be defined when using logo config.
```

When `serveDebugUI` is on, the server writes
`<webAssetsDir>/assets/config/runtime-config.json` before it mounts the dev UI,
so the UI boots with its configuration already in hand:

```json
{
  "backendUrl": "",
  "telemetry": null,
  "logo": {"text": "Acme Agents", "imageUrl": "https://example.com/acme.svg"}
}
```

`telemetry` carries the consent recorded in `~/.adk/config.json`, and is `null`
when no preference is recorded. Keys the dev UI build shipped are preserved; a
`logo` key is removed when neither logo option is set. If the file cannot be
written the server logs the failure at error level and starts anyway.

The same values are also served over HTTP:

```console
$ curl localhost:8000/dev-ui/config
{"logo_text":"Acme Agents","logo_image_url":"https://example.com/acme.svg"}
```

Both keys are `null` when unset. They are `snake_case`, unlike the rest of this
server, because the dev UI bundle is shared with the Python SDK and reads those
key names.
