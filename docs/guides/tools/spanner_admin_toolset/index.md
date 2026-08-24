# SpannerAdminToolset

Gives an agent seven Cloud Spanner Admin API tools: list and inspect instances
and instance configs, list databases, and create an instance or a database.
Reach for it when the agent must administer Spanner itself, rather than read or
write rows in a database.

## Introduction

The Spanner Admin API is two separate clients, `InstanceAdminClient` and
`DatabaseAdminClient`, and every call needs a fully qualified resource name such
as `projects/my-project/instances/my-instance`. A model cannot be trusted to
build those names, and a raw client failure is an exception rather than
something a model can read.

`SpannerAdminToolset` closes both gaps. It builds each resource name from plain
ids the model supplies, and it reports every failure as a result object the
model can act on. It is a `BaseToolset`, so an `LlmAgent` accepts it directly in
`tools` and each of the seven tools is an ordinary `FunctionTool` with a
declared argument schema.

This is the TypeScript port of adk-python's toolset of the same name. The tool
names, the argument names and the result shapes match, so one agent prompt
works against either SDK.

`@google-cloud/spanner-api` is an optional peer dependency. Importing `@google/adk`
never loads it; the toolset loads it on the first tool call. An application that
does not administer Spanner does not download it.

## Get started

Install the peer dependency:

```sh
npm install @google-cloud/spanner-api
```

Give the toolset to an agent:

```ts
import {LlmAgent, SpannerAdminToolset} from '@google/adk';

const agent = new LlmAgent({
  name: 'spanner_admin_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Administer Cloud Spanner for the user.',
  tools: [new SpannerAdminToolset()],
});
```

The model now sees seven functions: `spanner_list_instances`,
`spanner_get_instance`, `spanner_list_instance_configs`,
`spanner_get_instance_config`, `spanner_create_instance`,
`spanner_list_databases` and `spanner_create_database`.

To import only the Spanner tools, without evaluating the rest of the ADK
barrel, use the subpath:

```ts
import {SpannerAdminToolset} from '@google/adk/tools/spanner';
```

## The tools

| Tool                            | Arguments                                                                     | Result on success                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `spanner_list_instances`        | `project_id`                                                                  | `results`: instance ids                                                                        |
| `spanner_get_instance`          | `project_id`, `instance_id`                                                   | `results`: `instance_id`, `display_name`, `config`, `node_count`, `processing_units`, `labels` |
| `spanner_list_instance_configs` | `project_id`                                                                  | `results`: config ids                                                                          |
| `spanner_get_instance_config`   | `project_id`, `config_id`                                                     | `results`: `name`, `display_name`, `replicas`, `labels`                                        |
| `spanner_create_instance`       | `project_id`, `instance_id`, `config_id`, `display_name`, `nodes` (default 1) | `results`: `Instance <id> created successfully.`                                               |
| `spanner_list_databases`        | `project_id`, `instance_id`                                                   | `results`: database ids                                                                        |
| `spanner_create_database`       | `project_id`, `instance_id`, `database_id`                                    | no `results` key                                                                               |

The argument names are `snake_case` because the model reads them and they must
match adk-python. The list tools return bare ids, not full resource names.

`spanner_create_instance` and `spanner_create_database` create billable Google
Cloud resources, and both descriptions say so to the model. Each is a
long-running operation, and the tool waits for it to finish before answering,
so the model never reports success on a creation that later fails. The wait is
bounded at 300 seconds, matching adk-python; a slower operation returns an
error while the operation itself keeps running in Cloud Spanner.

## Results and errors

Every tool returns one of two shapes and never throws:

```ts
type SpannerToolResult =
  | {status: 'SUCCESS'; results?: unknown}
  | {status: 'ERROR'; error_details: string};
```

A rejected Admin API call, a failed or too-slow long-running operation, missing
credentials and a missing `@google-cloud/spanner-api` package all arrive as
`{status: 'ERROR', error_details}`. The model reads the message and can retry or
tell the user.

`spanner_create_database` also rejects a `database_id` containing a backtick.
The id is quoted with backticks inside `CREATE DATABASE`, so a backtick in it
would let the model append arbitrary DDL. adk-python has the same hole; this
port closes it.

## Credentials

By default the toolset uses Application Default Credentials, scoped to
`https://www.googleapis.com/auth/spanner.admin`. Run
`gcloud auth application-default login` locally, or rely on the service account
of the host.

`clientOptions` reaches the two Admin API clients, so anything they accept —
`keyFilename`, `credentials`, `authClient`, `projectId`, `apiEndpoint` — works
here:

```ts
import {LlmAgent, SpannerAdminToolset} from '@google/adk';

const agent = new LlmAgent({
  name: 'spanner_admin_agent',
  model: 'gemini-2.5-flash',
  tools: [
    new SpannerAdminToolset({
      clientOptions: {keyFilename: process.env.SPANNER_KEY_FILE},
    }),
  ],
});
```

adk-python instead runs an interactive OAuth flow through its `GoogleTool`
wrapper. adk-js has no `GoogleTool` yet, so credentials come from the client
options above.

## Exposing a subset

`toolFilter` takes a list of names or a predicate. A read-only agent:

```ts
new SpannerAdminToolset({
  toolFilter: ['spanner_list_instances', 'spanner_list_databases'],
});
```

Names in the list carry the `spanner_` prefix, as they do for `MCPToolset` and
`OpenAPIToolset`. adk-python filters on the unprefixed name, so a filter copied
from Python returns no tools until you add the prefix.

A predicate needs a `ReadonlyContext` to run. The agent supplies one; a direct
`getTools()` call without a context returns every tool.

## Releasing the clients

The two Admin API clients hold gRPC channels. `close()` releases them:

```ts
const toolset = new SpannerAdminToolset();
// ... run the agent ...
await toolset.close();
```

It is safe to call twice, and safe to call when no tool ever ran, in which case
no client was built.
