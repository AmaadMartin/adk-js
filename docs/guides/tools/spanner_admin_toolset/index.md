# SpannerAdminToolset

`SpannerAdminToolset` gives an agent the administration side of Cloud Spanner:
it can list the instances a project owns, read one instance or instance config,
list the databases on an instance, and create an instance or a database. Reach
for it when the user asks what a project holds, or asks you to provision
something in it.

## Introduction

`SpannerToolset` reads data. It answers "what is in the `orders` database", and
it deliberately stops there: instance and database administration is a
different concern, against a different API, with a different blast radius. This
toolset is that other half.

The two are independent. An agent may hold either, or both, and neither knows
about the other. They share their credentials configuration, their `spanner_`
name prefix and their result envelope, so an agent holding both sees one
consistent set of tools.

Five of the seven tools only read. The other two, `spanner_create_instance` and
`spanner_create_database`, provision billable Cloud Spanner resources that are
charged until you delete them. There is no confirmation prompt: the model
decides, and the tool acts. If you want an agent that can describe a project but
not change it, pass a `toolFilter` naming the five read-only tools, as
[Tool filtering](#tool-filtering) shows.

## Get started

`@google-cloud/spanner` is an optional peer dependency. Install it beside ADK:

```sh
npm install @google/adk @google-cloud/spanner
```

The simplest configuration gives every end user one identity, taken from
Application Default Credentials:

```ts
import {LlmAgent} from '@google/adk';
import {
  SPANNER_DEFAULT_SCOPES,
  SpannerAdminToolset,
} from '@google/adk/tools/spanner';
import {GoogleAuth} from 'google-auth-library';

const authClient = await new GoogleAuth({
  scopes: [...SPANNER_DEFAULT_SCOPES],
}).getClient();

const agent = new LlmAgent({
  name: 'spanner_admin',
  model: 'gemini-2.5-flash',
  instruction: 'Help the user inspect and provision Spanner instances.',
  tools: [new SpannerAdminToolset({credentialsConfig: {authClient}})],
});
```

That agent gets seven tools:

| Tool                            | What it does                              |
| ------------------------------- | ----------------------------------------- |
| `spanner_list_instances`        | the instance ids of one project           |
| `spanner_get_instance`          | one instance's config, nodes and labels   |
| `spanner_list_instance_configs` | the instance config ids of one project    |
| `spanner_get_instance_config`   | one config's replicas and their locations |
| `spanner_list_databases`        | the database ids on one instance          |
| `spanner_create_instance`       | creates an instance (**billable**)        |
| `spanner_create_database`       | creates a database (**billable**)         |

Every tool answers with `{status: 'SUCCESS', ...}` or
`{status: 'ERROR', error_details}`. A tool never throws, so a rejected call
reaches the model as a message it can react to.

## Results

`spanner_list_instances`, `spanner_list_instance_configs` and
`spanner_list_databases` answer with a list of ids, not full resource names:

```json
{"status": "SUCCESS", "results": ["orders", "staging"]}
```

`spanner_get_instance` answers with six fields:

```json
{
  "status": "SUCCESS",
  "results": {
    "instance_id": "orders",
    "display_name": "Orders",
    "config": "projects/my-project/instanceConfigs/regional-us-central1",
    "node_count": 1,
    "processing_units": 1000,
    "labels": {"env": "prod"}
  }
}
```

`spanner_get_instance_config` reports each replica's type by name
(`READ_WRITE`, `READ_ONLY`, `WITNESS`), not by its wire number:

```json
{
  "status": "SUCCESS",
  "results": {
    "name": "projects/my-project/instanceConfigs/nam3",
    "display_name": "nam3",
    "replicas": [
      {
        "location": "us-east4",
        "type": "READ_WRITE",
        "default_leader_location": true
      }
    ],
    "labels": {}
  }
}
```

`spanner_create_instance` answers with a sentence naming what it made, and
`spanner_create_database` answers with `{"status": "SUCCESS"}` and nothing
else. The asymmetry matches adk-python.

## Creating resources

`spanner_create_instance` takes `project_id`, `instance_id`, `config_id`,
`display_name` and `nodes`, which defaults to 1. `spanner_create_database`
takes `project_id`, `instance_id` and `database_id`.

Both start a long-running operation and wait for it, giving up after 300
seconds and reporting `ERROR`. A tool call blocks the agent turn, so the bound
is what stops an instance that never finishes provisioning from holding the
turn open forever. The resource may still appear afterwards: the timeout stops
the wait, not the operation.

`database_id` is quoted into a `CREATE DATABASE` statement, so it is checked
against Spanner's own grammar — `[a-z][a-z0-9_-]*[a-z0-9]`, 2 to 30 characters
— before any client is opened. An id outside that grammar answers `ERROR` and
never reaches Spanner. adk-python does not make this check.

## Credentials

`credentialsConfig` takes exactly one of three shapes, the same three
`SpannerToolset` takes.

```ts
// 1. One identity for every end user.
new SpannerAdminToolset({credentialsConfig: {authClient}});

// 2. A token another component already minted, read from session state.
new SpannerAdminToolset({
  credentialsConfig: {externalAccessTokenKey: 'spanner_token'},
});

// 3. Each end user acting as themselves, through the OAuth flow.
new SpannerAdminToolset({
  credentialsConfig: {
    clientId: process.env.SPANNER_OAUTH_CLIENT_ID,
    clientSecret: process.env.SPANNER_OAUTH_CLIENT_SECRET,
  },
});
```

The constructor rejects a config that names none of them, or more than one.
`SPANNER_DEFAULT_SCOPES` already includes
`https://www.googleapis.com/auth/spanner.admin`, so no scope change is needed.

With the OAuth flow, the first tool call asks the user to authorize and answers
`ERROR` with a message saying so. The resolved token is cached in that user's
session state, so later calls in the same session go straight through.

## Tool filtering

`toolFilter` takes a list of names or a predicate, and both see the tool under
its prefixed name. This is how you build an agent that inspects a project but
cannot change it:

```ts
new SpannerAdminToolset({
  credentialsConfig: {authClient},
  toolFilter: [
    'spanner_list_instances',
    'spanner_get_instance',
    'spanner_list_databases',
    'spanner_list_instance_configs',
    'spanner_get_instance_config',
  ],
});
```

This differs from adk-python, which filters on the bare name, so a filter
ported from Python needs the `spanner_` prefix added. It matches
`SpannerToolset` in this package. A name no tool carries is ignored.

An empty list exposes no tools, as it does in adk-python. Omit `toolFilter` to
expose every tool.

## Resources

Each tool call builds its own Spanner client and closes it before it answers. A
client is never shared between calls, because the credentials belong to one end
user and a reused client would serve the next user under the previous user's
identity. `close()` on the toolset is therefore a no-op.

## Trying it against a real project

The two create tools are not exercised against Cloud Spanner in the test suite,
because they cost money. To check them by hand you need Application Default
Credentials and `roles/spanner.admin` on the project:

```sh
gcloud auth application-default login
npm install @google-cloud/spanner
npm run sample -- samples/tools/spanner_admin/agent.ts
```

The sample filters the toolset down to the five read-only tools. Ask it to list
your instances, then remove the `toolFilter` and ask it to create a database on
an instance you already own. Delete the database afterwards.
