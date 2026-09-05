# BigtableToolset

Gives an agent a fixed set of read-only Bigtable tools: it can list instances,
tables and clusters, read their metadata, and run a GoogleSQL query. Reach for
it when the agent needs to answer questions about data you keep in Bigtable,
and you want to control the credentials and the size of a query result.

## Introduction

An agent that needs Bigtable data has two options. It can be given a
hand-written function tool per query, which is precise but does not generalise.
Or it can be given `BigtableToolset`, which exposes the Bigtable surface once
and lets the model choose the call.

The toolset solves three problems that a hand-written tool leaves open. The
model never sees credentials: the toolset resolves them and injects them after
the model has chosen its arguments, so no credential appears in the tool
schema. A query result is capped, so one broad `SELECT` cannot fill the
context window. And a failure comes back as a result the model can read, not as
an exception that ends the turn.

The Bigtable SDK is an optional peer dependency. Install
`@google-cloud/bigtable` alongside `@google/adk`; an application that does not
use these tools never downloads it. The package is loaded on the first tool
call, so building an agent with the toolset costs nothing until a tool runs.

The tools the model sees are `bigtable_list_instances`,
`bigtable_get_instance_info`, `bigtable_list_tables`, `bigtable_get_table_info`,
`bigtable_list_clusters`, `bigtable_get_cluster_info` and
`bigtable_execute_sql`.

## Get started

```bash
npm install @google/adk @google-cloud/bigtable
```

```ts
import {BigtableToolset, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'bigtable_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Answer questions about the user Bigtable tables.',
  tools: [new BigtableToolset()],
});
```

With no options the tools authenticate with application default credentials,
and a query returns at most 50 rows.

## Choosing the credentials

`BigtableCredentialsConfig` names one of three ways to authenticate. Supply
credentials you already hold, name a session-state key holding an access token
the host obtained elsewhere, or give an OAuth2 client so the end user grants
consent.

```ts
import {BigtableCredentialsConfig, BigtableToolset} from '@google/adk';

const toolset = new BigtableToolset({
  credentialsConfig: new BigtableCredentialsConfig({
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  }),
});
```

With an OAuth2 client the first tool call asks the end user for consent and
returns the text `User authorization is required to access Google services for
bigtable_list_instances. Please complete the authorization flow.` No Bigtable
client is opened until the user responds. The resolved token is cached in
session state under `bigtable_token_cache`, and the default scopes are
`bigtable.admin` and `bigtable.data`.

## Capping a query result

`bigtableToolSettings` sets how many rows `bigtable_execute_sql` returns. The
read stops at the cap, so a query matching a million rows never buffers them.

```ts
import {BigtableToolset} from '@google/adk';

const toolset = new BigtableToolset({
  bigtableToolSettings: {maxQueryResultRows: 20},
});
```

When the cap stops the read, the result carries
`resultIsLikelyTruncated: true`, so the model can say that more rows match.

## Choosing which tools to expose

`toolFilter` takes the unprefixed operation names, or a predicate over the
tools. An empty list exposes nothing, and a name that matches no operation is
ignored.

```ts
const toolset = new BigtableToolset({
  toolFilter: ['list_tables', 'get_table_info', 'execute_sql'],
});
```

## What a tool returns

Every tool returns an object rather than throwing, so a failure reaches the
model as something it can act on.

```ts
// bigtable_list_tables
{
  status: 'SUCCESS',
  results: [
    {
      projectId: 'my-project',
      instanceId: 'my-instance',
      tableId: 'users',
      tableName: 'projects/my-project/instances/my-instance/tables/users',
    },
  ],
}

// bigtable_execute_sql, with the row cap reached
{
  status: 'SUCCESS',
  rows: [{user_id: '1', user_name: 'Alice'}],
  resultIsLikelyTruncated: true,
}

// any failure
{status: 'ERROR', errorDetails: "Error in tool 'bigtable_execute_sql': ..."}
```

A query value that JSON cannot carry is converted rather than dropped. A 64-bit
integer becomes a string of its digits, a byte string becomes base64, and a
timestamp becomes an ISO instant.

## Releasing the clients

The toolset opens one Bigtable client per project, and each client owns gRPC
channels. Call `close()` when the agent is done.

```ts
await toolset.close();
```
