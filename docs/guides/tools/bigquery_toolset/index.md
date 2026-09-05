# BigQueryToolset

Gives an agent eleven tools for BigQuery: reading dataset, table and job
metadata, running SQL, and running BigQuery's built-in AI and ML analyses.
Reach for it when the agent has to answer questions from data that already
lives in BigQuery.

## Introduction

An agent that reasons over a warehouse needs two things the model cannot
supply: the shape of the data, and a way to run a query. `BigQueryToolset`
provides both as one set of tools, so you do not hand-write a tool per table
or per question.

The toolset is read-only by default. `writeMode` is the switch that decides
what the model may do, and it is enforced by BigQuery rather than by prompt
text: before a query runs, the toolset dry-runs it and reads back the
statement type BigQuery parsed. A `BLOCKED` toolset refuses anything that is
not a `SELECT`. A `PROTECTED` toolset opens a BigQuery session and allows a
write only into that session's anonymous dataset, so a temporary table is
fine and a permanent one is refused. `ALLOWED` runs whatever the model asks
for.

Every tool returns its failure instead of throwing it. A refused query, a
missing table or an expired credential comes back as
`{status: 'ERROR', error_details: '...'}`, which the model reads and can act
on, rather than aborting the turn.

`@google-cloud/bigquery` and `@google-cloud/dataplex` are optional peer
dependencies. Building a toolset loads neither; the first tool call loads the
one it needs. An application that never touches BigQuery does not download
them.

## Get started

Install the clients the tools call through:

```sh
npm install @google-cloud/bigquery @google-cloud/dataplex
```

Then hand a toolset to an agent. With no options it exposes all eleven tools,
read-only, authenticating with the application default credentials of the
process:

```ts
import {BigQueryToolset, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'bigquery_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer questions about BigQuery data. Use list_dataset_ids and ' +
    'list_table_ids to find the data, get_table_info to read a schema, ' +
    'and execute_sql to query it.',
  tools: [new BigQueryToolset()],
});
```

## The tools

| Tool                   | What it does                                            |
| ---------------------- | ------------------------------------------------------- |
| `list_dataset_ids`     | Lists the datasets of a project.                        |
| `get_dataset_info`     | Reads a dataset's metadata.                             |
| `list_table_ids`       | Lists the tables of a dataset.                          |
| `get_table_info`       | Reads a table's schema and statistics.                  |
| `get_job_info`         | Reads a job's configuration, statistics and query.      |
| `execute_sql`          | Runs a query, or describes it when `dry_run` is true.   |
| `forecast`             | Forecasts a time series with `AI.FORECAST`.             |
| `analyze_contribution` | Explains a test-versus-control difference.              |
| `detect_anomalies`     | Finds anomalies with a BigQuery ML `ARIMA_PLUS` model.  |
| `ask_data_insights`    | Answers a question about named tables in one call.      |
| `search_catalog`       | Finds datasets and tables by description, via Dataplex. |

`forecast`, `analyze_contribution` and `detect_anomalies` each train a
temporary BigQuery ML model, which needs a session. A `BLOCKED` toolset
refuses the last two outright; `analyze_contribution` and `detect_anomalies`
narrow an `ALLOWED` toolset to a session for their two statements, so the
model they create cannot outlive the call.

## Choosing the tools to expose

`toolFilter` takes the names to keep, or a predicate. A name the toolset does
not have selects nothing, and an absent or empty filter exposes everything:

```ts
const metadataOnly = new BigQueryToolset({
  toolFilter: ['list_dataset_ids', 'get_dataset_info', 'list_table_ids'],
});
```

## Configuration

`bigqueryToolConfig` is validated when the toolset is built, so a bad value
fails at startup rather than on the first tool call:

```ts
import {BigQueryToolset, WriteMode} from '@google/adk';

const toolset = new BigQueryToolset({
  bigqueryToolConfig: {
    writeMode: WriteMode.PROTECTED,
    maxQueryResultRows: 200,
    maximumBytesBilled: 10_485_760,
    applicationName: 'my-agent',
    computeProjectId: 'my-compute-project',
    location: 'europe-west1',
    jobLabels: {team: 'data'},
  },
});
```

| Field                | Default   | What it does                                                                     |
| -------------------- | --------- | -------------------------------------------------------------------------------- |
| `writeMode`          | `BLOCKED` | What the model may write.                                                        |
| `maximumBytesBilled` | none      | Caps the bytes a query bills. Must be at least `10485760`.                       |
| `maxQueryResultRows` | `50`      | Caps the rows a result carries.                                                  |
| `applicationName`    | none      | Tags the user agent and the job labels. No space allowed.                        |
| `computeProjectId`   | none      | Refuses a query for any other project.                                           |
| `location`           | none      | Pins the BigQuery location.                                                      |
| `jobLabels`          | none      | Labels every job. At most 20; no empty key, and no key starting `adk-bigquery-`. |

Two labels are added to every job on top of yours: `adk-bigquery-tool` names
the calling tool, and `adk-bigquery-application-name` carries
`applicationName` when it is set. That prefix is reserved, which is why a key
of your own may not start with it.

## Credentials

`credentialsConfig` carries the authentication subset of the BigQuery client
options. Leave it out to use the application default credentials of the
process:

```ts
const toolset = new BigQueryToolset({
  credentialsConfig: {keyFilename: '/path/to/service-account.json'},
});
```

`scopes` defaults to the BigQuery scope plus the Dataplex read-write scope,
which `search_catalog` needs.

## What the tools return

A metadata tool returns its value directly: `list_dataset_ids` resolves to an
array of ids, `get_table_info` to the table resource. `execute_sql` and the
BigQuery ML tools return `{status: 'SUCCESS', rows: [...]}`, and add
`result_is_likely_truncated: true` when the row count hit
`maxQueryResultRows`. A `dry_run` returns `{status: 'SUCCESS', dry_run_info}`
instead of rows.

Every result key is `snake_case`, because the model reads it and adk-python
produces the same keys.

## Releasing the clients

The toolset caches one BigQuery client per project, location and user agent.
`close()` releases them:

```ts
await toolset.close();
```

## Injection defences

A table name, a column name and a `CREATE MODEL` option cannot be a query
parameter, so the BigQuery ML tools interpolate them. The model chooses those
values, so each one is checked first: a table identifier must match
`[A-Za-z0-9_.:-]+` and a column identifier `[A-Za-z0-9_-]+`. A value that
does not returns `Invalid BigQuery identifier: <value>`. A caller-supplied
subquery is dry-run and refused unless BigQuery parses it as a `SELECT`.
