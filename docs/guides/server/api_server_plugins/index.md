# Attaching plugins to the agents an API server serves

`AdkApiServer` can attach plugins to every agent it serves, without editing
the agent. Reach for this when the plugin is an operator's concern rather than
the agent author's: request logging, an audit trail, or the BigQuery analytics
plugin.

## Introduction

A plugin normally reaches a `Runner` through the `App` an agent module
exports, so the agent author decides what runs. That is the wrong owner for
some plugins. An operator running a fleet of agents wants one audit plugin on
all of them, and wants to turn analytics on for one app without a code change.

The server offers two ways in, and applies both when the runner for an app is
first built:

- `extraPlugins` names plugins on the command line. They apply to every app
  the server serves.
- A `plugins.yaml` file in an app's directory configures the BigQuery agent
  analytics plugin for that app alone.

Neither replaces what the app already declares. The plugins from both sources
are appended to the app's own list, in that order.

## Get started

Name a plugin with a fully-qualified name, `<module specifier>#<export>`:

```console
$ adk api_server ./agents --extra_plugins ./plugins/audit.js#AuditPlugin
```

The export may be a plugin instance or a plugin class. A class is constructed
with the qualified name as its plugin name.

```ts
import {BasePlugin} from '@google/adk';

export class AuditPlugin extends BasePlugin {}

export const auditPlugin = new AuditPlugin('audit');
```

`./plugins/audit.js#AuditPlugin` names the class, and
`./plugins/audit.js#auditPlugin` names the instance. Override the callbacks
your plugin needs; `BasePlugin` defaults every one of them to doing nothing.

The same option is available when you build the server yourself:

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  extraPlugins: ['./plugins/audit.js#AuditPlugin'],
});

await server.start();
```

Pass several by separating them with commas:

```console
$ adk web ./agents --extra_plugins ./a.js#One,./b.js#Two
```

## What a qualified name may point at

The specifier is a package name or a file path, and `#` separates the export
from it. A name with no `#` reads the module's default export.

Two specifiers are refused, because the name reaches this server from a
command line or a configuration file rather than from your source: a Node
built-in module, and a specifier carrying its own URL scheme such as `data:`.
Loading a plugin runs the named module's top-level code, so trust the names as
far as you trust where they came from.

A name that cannot be loaded is reported at error level and skipped. The
server still starts, and the remaining names still load. The same happens for
a name that resolves to something that is neither a plugin nor a plugin class.

## BigQuery analytics through plugins.yaml

Put `plugins.yaml` beside the agent, in `<agentsDir>/<appName>/`:

```yaml
bigquery_agent_analytics:
  project_id: my-project
  dataset_id: my_dataset
  dataset_location: us-central1
  table_id: my_table
```

The keys are snake_case because adk-python reads the same file.

`project_id`, `dataset_id` and `dataset_location` are all required. The plugin
is not attached when any of them is missing, so a half-written file turns
analytics off rather than sending rows somewhere unintended. `table_id` is
optional and the plugin defaults it.

A file that is not valid YAML, or that does not parse to a mapping, is
reported and the app runs without the plugin. adk-python lets that failure
propagate and stop the runner from being built; adk-js keeps the agent
serving.

## When the plugins are resolved

The server builds one `Runner` per app and caches it, so both sources are read
once per app rather than once per request. Editing `plugins.yaml` while the
server runs has no effect until the server restarts.
