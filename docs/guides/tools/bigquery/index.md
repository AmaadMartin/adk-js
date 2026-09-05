# BigQueryToolset

`BigQueryToolset` gives an agent five read tools for BigQuery: it can list the
datasets in a project, read dataset and table metadata, list the tables in a
dataset, and run a SQL query. Reach for it when the answers your agent needs
live in BigQuery and you do not want to write an OpenAPI toolset or handle
OAuth yourself.

## Introduction

BigQuery's REST API is large, and much of it is a poor fit for a model. Several
methods overlap, many parameters are rarely used, and a generated toolset
exposes all of them. This toolset is hand-written instead: five tools, each with
a short model-facing description and two or three arguments.

The other half of the problem is the credential. Every tool needs an OAuth
token for the end user, and asking each tool to run its own authorization flow
would prompt the user five times. The toolset gives all five tools one
`BigQueryCredentialsConfig`. The first tool call resolves a credential, caches
it in session state under `bigquery_token_cache`, and every later tool call in
that session reuses it.

`BigQueryToolset` extends `BaseToolset`, so it behaves like any other toolset:
you pass it to `LlmAgent` in the `tools` array, and `toolFilter` narrows what
the model sees. `@google-cloud/bigquery` is an optional peer dependency, loaded
on the first tool call, so importing `@google/adk` does not require it.

## Get started

Install the client library:

```sh
npm install @google-cloud/bigquery
```

Then build an agent over the toolset:

```ts
import {BigQueryToolset, LlmAgent} from '@google/adk';

const bigqueryToolset = new BigQueryToolset({
  credentialsConfig: {
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  },
});

const agent = new LlmAgent({
  name: 'bigquery_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You answer questions about BigQuery data and metadata.',
  tools: [bigqueryToolset],
});
```

On the first tool call the agent asks the user to authorize. That turn's tool
result is the sentence `User authorization is required to access Google
services for <tool>. Please complete the authorization flow.`, and the
framework emits an `adk_request_credential` call alongside it. Once the user
consents, the tool runs.

## The tools

| Name               | Arguments                              | Result                                |
| ------------------ | -------------------------------------- | ------------------------------------- |
| `list_dataset_ids` | `project_id`                           | The dataset ids in the project.       |
| `get_dataset_info` | `project_id`, `dataset_id`             | The `bigquery#dataset` REST resource. |
| `list_table_ids`   | `project_id`, `dataset_id`             | The table ids in the dataset.         |
| `get_table_info`   | `project_id`, `dataset_id`, `table_id` | The `bigquery#table` REST resource.   |
| `execute_sql`      | `project_id`, `query`                  | `{rows: [...]}`.                      |

The tool names, the argument names and the result keys are `snake_case`,
matching adk-python, so a prompt written for either SDK sees the same shapes.

## Choosing a credential

`BigQueryCredentialsConfig` takes one of two forms, never both.

Give it an OAuth client id and secret when each end user has to grant access to
their own data:

```ts
new BigQueryToolset({
  credentialsConfig: {
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
    scopes: ['https://www.googleapis.com/auth/bigquery'],
  },
});
```

`scopes` defaults to `https://www.googleapis.com/auth/bigquery`.

Give it an existing credential when the agent already holds one that may read
every end user's data — a deployment whose service account has the access it
needs, for example. No end user is then sent through the OAuth flow:

```ts
new BigQueryToolset({
  credentialsConfig: {
    credentials: {
      clientId: process.env.OAUTH_CLIENT_ID!,
      clientSecret: process.env.OAUTH_CLIENT_SECRET!,
      refreshToken: process.env.OAUTH_REFRESH_TOKEN!,
    },
  },
});
```

The credential must carry all three fields. BigQuery is called as an authorized
user, and the client library mints access tokens from the refresh token.

Omitting `credentialsConfig` entirely runs the tools with no credential, and
the client library falls back to the application default credentials of the
process.

## Narrowing what the model sees

`toolFilter` takes the names to keep, or a predicate. A name the toolset does
not have selects nothing, and never throws:

```ts
new BigQueryToolset({
  credentialsConfig: {clientId, clientSecret},
  toolFilter: ['list_dataset_ids', 'get_dataset_info'],
});
```

## Failure modes

No BigQuery tool throws. A failure comes back as a result the model can read
and report:

```json
{"status": "ERROR", "error_details": "Access Denied: Project my-project"}
```

That covers a rejected API call, an argument that does not match the schema,
and a failed credential resolution alike.

Two other limits are worth knowing:

- `execute_sql` downloads at most 50 rows. When the result holds exactly 50, it
  also carries `result_is_likely_truncated: true`, which tells the model that
  further matching rows may exist.
- Nothing inspects the SQL the model wrote. The guardrail is the OAuth scope
  you grant, so grant a read-only one if the agent should not write.
