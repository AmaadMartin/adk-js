# BigQueryToolset

Gives an agent a fixed set of BigQuery tools: it can list datasets and tables,
read their metadata and a job's, run SQL under a write-mode guardrail, and use
BigQuery's forecasting, contribution and anomaly analyses. Reach for it when
the agent needs to answer questions about data you keep in BigQuery, and you
want to control the credentials, what the agent may write, and how large a
query result gets.

## Introduction

An agent that needs BigQuery data has two options. It can be given a
hand-written function tool per query, which is precise but does not generalise.
Or it can be given `BigQueryToolset`, which exposes the BigQuery surface once
and lets the model choose the call.

The toolset solves four problems a hand-written tool leaves open. The model
never sees credentials: the toolset resolves them per call and passes them to
the client after the model has chosen its arguments, so no credential appears
in the tool schema. Writes are refused by default, and the description the
model reads changes with the write mode, so it is told what it may do rather
than being corrected afterwards. A query result is capped, so one broad
`SELECT` cannot fill the context window. And a failure comes back as a result
the model can read, not as an exception that ends the turn.

`@google/adk` already exports a different class called `BigQueryToolset`,
generated from the BigQuery Discovery document. That one wraps the REST API
method by method. This one is hand written, and is imported from
`@google/adk/integrations/bigquery`.

The BigQuery and Dataplex SDKs are optional peer dependencies. Install
`@google-cloud/bigquery` alongside `@google/adk`, and `@google-cloud/dataplex`
if the agent uses `search_catalog`; an application that does not use these
tools never downloads them. A package is loaded on the first tool call that
needs it, so building an agent with the toolset costs nothing until a tool
runs.

The eleven tools the model sees are `get_dataset_info`, `get_table_info`,
`list_dataset_ids`, `list_table_ids`, `get_job_info`, `execute_sql`,
`forecast`, `analyze_contribution`, `detect_anomalies`, `ask_data_insights`
and `search_catalog`. The names carry no prefix, matching adk-python.

## Get started

```bash
npm install @google/adk @google-cloud/bigquery @google-cloud/dataplex
```

```ts
import {LlmAgent} from '@google/adk';
import {BigQueryToolset} from '@google/adk/integrations/bigquery';

const agent = new LlmAgent({
  name: 'bigquery_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Answer questions about the user BigQuery data.',
  tools: [new BigQueryToolset()],
});
```

With no options the tools authenticate with application default credentials,
`execute_sql` accepts only `SELECT`, and a query returns at most 50 rows.

## Choosing what the agent may write

`writeMode` decides which statements `execute_sql` runs, and the description
the model reads changes with it.

| `writeMode`                   | What `execute_sql` accepts                                                |
| ----------------------------- | ------------------------------------------------------------------------- |
| `WriteMode.BLOCKED` (default) | Only `SELECT`.                                                            |
| `WriteMode.PROTECTED`         | `SELECT`, and a write inside the anonymous dataset of a BigQuery session. |
| `WriteMode.ALLOWED`           | Every statement.                                                          |

```ts
import {BigQueryToolset, WriteMode} from '@google/adk/integrations/bigquery';

const toolset = new BigQueryToolset({
  bigqueryToolConfig: {writeMode: WriteMode.PROTECTED},
});
```

The guardrail is enforced at run time, not only in the description. Before it
runs a statement the tool plans it with a dry run and reads back the statement
type BigQuery decided, so a write disguised as a read is still refused. In
`PROTECTED` mode the toolset opens a BigQuery session on the first call and
remembers it in session state under `bigquery_session_info`, so a temporary
table one call creates is still there on the next.

`analyze_contribution` and `detect_anomalies` create a temporary model, so they
need a session. They refuse to run in `BLOCKED` mode, and they run in a session
in the other two.

## Choosing the credentials

`BigQueryCredentialsConfig` names one of three ways to authenticate. Supply
credentials you already hold, name a session-state key holding an access token
the host obtained elsewhere, or give an OAuth2 client so the end user grants
consent.

```ts
import {
  BigQueryCredentialsConfig,
  BigQueryToolset,
} from '@google/adk/integrations/bigquery';

const toolset = new BigQueryToolset({
  credentialsConfig: new BigQueryCredentialsConfig({
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  }),
});
```

With an OAuth2 client the first tool call asks the end user for consent and
returns the text `User authorization is required to access Google services for
list_dataset_ids. Please complete the authorization flow.` No BigQuery client
is opened until the user responds. The resolved token is cached in session
state under `bigquery_token_cache`, and the default scopes are
`https://www.googleapis.com/auth/bigquery` and
`https://www.googleapis.com/auth/dataplex.read-write`.

## The rest of the configuration

```ts
const toolset = new BigQueryToolset({
  bigqueryToolConfig: {
    maxQueryResultRows: 200,
    maximumBytesBilled: 10_485_760,
    applicationName: 'my-agent',
    computeProjectId: 'my-compute-project',
    location: 'us-central1',
    jobLabels: {team: 'data'},
  },
});
```

- `maxQueryResultRows` caps a query result. It defaults to 50.
- `maximumBytesBilled` caps what a query may cost. BigQuery on-demand pricing
  rounds up to the nearest MB with a 10 MB floor, so a value below `10485760`
  is rejected.
- `applicationName` is added to the BigQuery user agent and to a job label. It
  must not contain a space. Use it for tracking, never for a security
  decision.
- `computeProjectId` restricts `execute_sql` to one project. A query aimed
  anywhere else is refused.
- `location` picks the BigQuery location. Unset, BigQuery derives it from the
  query.
- `jobLabels` are added to every job the tools start. At most 20, no empty key,
  and no key starting with `adk-bigquery-`, which the tools reserve.

The configuration is validated in the constructor, so a mistake is reported
where it was made rather than on the first tool call. An unknown property is
rejected too.

## Choosing which tools to expose

`toolFilter` takes tool names, or a predicate over the tools. An empty list
exposes nothing, and a name that matches no tool is ignored.

```ts
const toolset = new BigQueryToolset({
  toolFilter: ['list_dataset_ids', 'get_dataset_info', 'execute_sql'],
});
```

## What a tool returns

Every tool returns an object rather than throwing, so a failure reaches the
model as something it can act on.

```ts
// list_dataset_ids
['america_health_rankings', 'austin_311'];

// execute_sql, with the row cap reached
{
  status: 'SUCCESS',
  rows: [{island: 'Dream', population: 124}],
  result_is_likely_truncated: true,
}

// execute_sql with dryRun
{status: 'SUCCESS', dry_run_info: {/* the job BigQuery planned */}}

// any failure, including a refused write
{status: 'ERROR', error_details: 'Read-only mode only supports SELECT statements.'}
```

The `status` and `error_details` keys are spelled as adk-python spells them, so
one prompt works against either SDK.

A query value that JSON cannot carry is converted rather than dropped: a 64-bit
integer, for example, becomes a string of its digits.

## Releasing the clients

`close()` exists because `BaseToolset` declares it, and it has nothing to do
here: a BigQuery client is built per call and holds no channel, and the
Dataplex client `search_catalog` opens is closed by the call that opened it.
Calling it is harmless.

```ts
await toolset.close();
```
