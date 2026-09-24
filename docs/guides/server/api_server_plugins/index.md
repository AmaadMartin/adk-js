# Per-app plugins and the default model

`AdkApiServer` builds one `Runner` per app. Before it does, it reads the app's
`plugins.yaml` and attaches the plugin that file declares. A separate option
sets the model for agents that declare none. Reach for either when you serve
several apps from one directory and want each one configured from disk.

## Introduction

A plugin is attached to an app, not to the server. An app written in code lists
its own plugins on its `App`, and the server passes those through untouched.
`plugins.yaml` is for a plugin an operator wants to add without editing the
app: the server reads `<agentsDir>/<appName>/plugins.yaml` once, when it builds
that app's runner, and attaches the plugin after the app's own. The file format
is shared with ADK Python, so its keys are snake_case. A server given no
`agentsDir` has no directory to read from, and attaches nothing.

Only one plugin is configurable this way today: the BigQuery agent analytics
plugin, under the `bigquery_agent_analytics` key. The server does not import
that plugin until an app asks for it. When the installed `@google/adk` does not
export `BigQueryAgentAnalyticsPlugin`, the server logs a warning, attaches no
plugin, and keeps serving the app.

`defaultLlmModel` is unrelated to plugins. An `LlmAgent` that sets no `model`
inherits one from an ancestor agent, and throws when no ancestor sets one
either. This option gives that agent a model instead. It is process-wide, so it
also reaches an agent bundled with its own copy of `@google/adk`.

## Get started

Write the file next to the agent it configures:

```yaml
# ./agents/echo/plugins.yaml
bigquery_agent_analytics:
  project_id: my-project
  dataset_id: agent_analytics
  table_id: agent_events
  dataset_location: US
```

Then start the server over that directory:

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  port: 8000,
  defaultLlmModel: 'gemini-2.5-flash',
});

await server.start();
```

The `echo` app now runs with the analytics plugin attached, and any agent that
declares no model uses `gemini-2.5-flash`. `--default_llm_model` is the same
option on the command line:

```console
$ adk web ./agents --default_llm_model gemini-2.5-flash
$ adk api_server ./agents --default_llm_model gemini-2.5-flash
```

## What `plugins.yaml` must set

`project_id`, `dataset_id` and `dataset_location` are all required. The server
attaches no plugin when any of them is missing, and logs a debug line naming
the ones it did not find. `table_id` is optional: leave it out and the plugin
picks its own table name.

Keys other than `bigquery_agent_analytics` are ignored. An absent file is not
an error. A file that does not parse as YAML is logged as a warning and treated
as absent, so one bad file does not stop the app from serving. ADK Python lets
the parse error propagate instead, which fails the request with a 500.

## Plugin order

The runner receives the app's own plugins first, then the plugin from
`plugins.yaml`. Order decides which plugin sees a callback first, and which one
can short-circuit the others.

## Setting the default model

`defaultLlmModel` calls `LlmAgent.setDefaultModel` when the server starts. The
value is a model name the LLM registry resolves. An agent that sets its own
model, or inherits one from an ancestor, is unaffected:

```ts
import {LlmAgent} from '@google/adk';

// Sets no model and has no parent, so it uses the server's defaultLlmModel.
const standalone = new LlmAgent({name: 'standalone'});

// Sets no model either, but inherits gemini-2.5-pro from its parent.
const child = new LlmAgent({name: 'child'});
const parent = new LlmAgent({
  name: 'parent',
  model: 'gemini-2.5-pro',
  subAgents: [child],
});
```

The override is process-wide state. A test that sets it should clear it with
`LlmAgent.setDefaultModel(undefined)` afterwards.
