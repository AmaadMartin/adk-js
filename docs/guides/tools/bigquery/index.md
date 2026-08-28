# BigQueryToolset

`BigQueryToolset` gives an agent six tools: five that read dataset, table and
job metadata, and `execute_sql`, which runs a BigQuery or BigQuery ML query.
Reach for it when the agent must answer questions about data that lives in
BigQuery, rather than data you can fit in the prompt.

## Introduction

An agent that analyses data needs two things: a way to discover what tables
exist, and a way to query them. Writing those tools by hand means writing the
BigQuery client wiring, the tool declarations, and the guardrails that stop a
model from dropping a table. This toolset ships all three.

The guardrail is the part worth understanding. `execute_sql` reads its SQL from
the model, so the text is untrusted. The toolset never inspects that text.
Instead it sends the query to BigQuery as a dry run first and reads back the
statement type BigQuery itself assigned. `WriteMode` then decides whether that
statement type may run. A model that hides `DROP TABLE` inside a comment or a
string still gets classified as `DROP_TABLE` by BigQuery, so the guard holds.

No tool throws. A BigQuery failure comes back to the model as
`{status: 'ERROR', error_details}`, so the model can read the message and try a
different query. A mistake in your own configuration is different: the
`BigQueryToolset` constructor throws for a bad byte cap, an application name
with a space, or a reserved job label.

## Get started

The default write mode is `BLOCKED`, which admits a `SELECT` statement and
nothing else.

```ts
import {LlmAgent} from '@google/adk';
import {BigQueryToolset} from '@google/adk-integrations';

const agent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about our BigQuery data.',
  tools: [new BigQueryToolset()],
});
```

With no `credentials`, every tool resolves Application Default Credentials. To
use a client you built yourself, pass it:

```ts
import {GoogleAuth} from 'google-auth-library';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/bigquery'],
});

const toolset = new BigQueryToolset({credentials: await auth.getClient()});
```

## The tools

| Tool               | What it returns                     |
| ------------------ | ----------------------------------- |
| `list_dataset_ids` | The dataset ids of a project.       |
| `get_dataset_info` | The BigQuery dataset resource.      |
| `list_table_ids`   | The table ids of a dataset.         |
| `get_table_info`   | The BigQuery table resource.        |
| `get_job_info`     | The BigQuery job resource.          |
| `execute_sql`      | The query rows, or the dry-run job. |

Every tool takes `project_id`. The names and the parameter names stay
snake_case, matching adk-python, so a prompt written for one SDK works on the
other.

Pass `toolFilter` to expose fewer tools. An agent that must never run SQL gets
the metadata tools only:

```ts
const metadataOnly = new BigQueryToolset({
  toolFilter: ['list_dataset_ids', 'list_table_ids', 'get_table_info'],
});
```

An empty `toolFilter` list means no filtering, so every tool is exposed. That
follows adk-js's `BaseToolset`, and differs from adk-python, where an empty
list exposes nothing.

## Write modes

`WriteMode` decides what `execute_sql` may run. It also decides what the model
reads: each mode ships a different tool description, with the examples that
match what the mode admits.

- `WriteMode.BLOCKED` (the default) admits only a statement BigQuery classifies
  as `SELECT`. Anything else returns
  `Read-only mode only supports SELECT statements.`
- `WriteMode.PROTECTED` opens a BigQuery session on the first query and admits
  a write whose destination is that session's anonymous dataset. The agent can
  build and drop a temporary table; a permanent table stays protected.
- `WriteMode.ALLOWED` admits every statement, and skips the dry run.

```ts
import {BigQueryToolset, WriteMode} from '@google/adk-integrations';

const scratch = new BigQueryToolset({
  toolConfig: {
    writeMode: WriteMode.PROTECTED,
    maxQueryResultRows: 100,
    location: 'us-central1',
  },
});
```

In `PROTECTED` mode the session id and its anonymous dataset are stored in the
session state under the key `bigquery_session_info`, as a two-element array.
Every later query in the same agent session reuses that session. The key and
the array shape match adk-python, so a session store that both SDKs read stays
readable.

## Guardrails

Every field of `toolConfig` is optional.

| Field                | Effect                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| `writeMode`          | What `execute_sql` may run. Defaults to `WriteMode.BLOCKED`.                        |
| `maxQueryResultRows` | Caps the rows a query returns. Defaults to 50.                                      |
| `maximumBytesBilled` | Caps what one query may bill. Must be 10485760 or more.                             |
| `computeProjectId`   | Pins the project. A query naming another one is refused before any client is built. |
| `location`           | Pins the BigQuery location for data and compute.                                    |
| `applicationName`    | Appended to the user agent and to the job labels. Must not contain a space.         |
| `jobLabels`          | Labels on every job. At most 20, and no key may start with `adk-bigquery-`.         |

When a result hits `maxQueryResultRows` exactly, the tool adds
`result_is_likely_truncated: true`, so the model knows more rows may match.

Every BigQuery job the toolset runs carries the label
`adk-bigquery-tool: execute_sql`, plus `adk-bigquery-application-name` when you
set `applicationName`. Every API call carries the user agent
`adk-bigquery-tool google-adk/<version>`.

## Reading a result

`execute_sql` returns one of three shapes:

```ts
// A query that ran.
{status: 'SUCCESS', rows: [{island: 'Dream', population: 124}]}

// dry_run: true.
{status: 'SUCCESS', dry_run_info: {/* the BigQuery job resource */}}

// Any failure.
{status: 'ERROR', error_details: 'Read-only mode only supports SELECT statements.'}
```

A row value that `JSON.stringify` rejects is replaced by its string form, so a
result always serializes into the conversation.
