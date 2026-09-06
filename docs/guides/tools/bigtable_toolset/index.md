# BigtableToolset

Gives an agent read access to Cloud Bigtable: six tools that report instance,
table and cluster metadata, and one that runs a GoogleSQL query. Reach for it
when the agent has to answer questions about data that lives in Bigtable
instead of in the prompt.

## Introduction

An agent that needs Bigtable data otherwise needs a hand-written tool per
question. `BigtableToolset` supplies the tools, so the agent describes what it
wants and the model picks the call. The toolset is read-only. Nothing in it
creates, updates or deletes a Bigtable resource.

The tools mirror `google.adk.tools.bigtable` in adk-python, down to the result
field names, so a prompt or an evaluation written against one SDK behaves the
same against the other.

`@google-cloud/bigtable` is an optional peer dependency. It is a large package
and most agents never touch Bigtable, so importing `@google/adk` does not pull
it in; the toolset loads it on the first tool call. Install it yourself:

```sh
npm install @google-cloud/bigtable
```

The toolset opens one Bigtable client per project id and caches it. Call
`close()` on the toolset to release them, or let the agent server close it at
the end of its lifecycle.

## Get started

```ts
import {LlmAgent, BigtableToolset} from '@google/adk';

const agent = new LlmAgent({
  name: 'bigtable_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the data in Cloud Bigtable.',
  tools: [new BigtableToolset()],
});
```

The tools authenticate with Application Default Credentials unless you say
otherwise. Every tool takes the project id as an argument, so one toolset serves
any project the credentials reach.

## The tools

| Tool                | Reports                                             |
| ------------------- | --------------------------------------------------- |
| `list_instances`    | every instance in a project                         |
| `get_instance_info` | one instance's display name, state, type and labels |
| `list_tables`       | every table in an instance                          |
| `get_table_info`    | one table's column families                         |
| `list_clusters`     | every cluster in an instance                        |
| `get_cluster_info`  | one cluster, including its autoscaling limits       |
| `execute_sql`       | the rows a GoogleSQL query returns                  |

These are the names the model sees. adk-python prefixes the same tools with
`bigtable_`; adk-js has no equivalent step, so the names stay bare here.

Every tool answers with the same envelope. A success carries
`{"status": "SUCCESS", ...}`, and a failure carries
`{"status": "ERROR", "error_details": "..."}` rather than raising. The model
therefore reads a Bigtable permission error as an answer and can explain it.

## Configuration

```ts
new BigtableToolset({
  toolFilter: ['execute_sql'],
  bigtableToolSettings: {maxQueryResultRows: 200},
  credentialsConfig: {keyFilename: process.env.BIGTABLE_KEY_FILE},
});
```

`toolFilter` selects the tools the agent sees. Leave it unset for all of them;
an empty list exposes none. A name the toolset does not own is ignored.

`maxQueryResultRows` caps a query result and defaults to 50. When the cap stops
the read, `execute_sql` adds `"result_is_likely_truncated": true` to its answer,
so the model knows more rows match.

`credentialsConfig` carries `credentials`, `keyFilename` and `scopes` straight
through to the Bigtable client. Without `scopes` the toolset asks for the
Bigtable admin and data scopes.

## Query parameters

Write a parameter into the query as `@name`, then give its value and its type:

```json
{
  "project_id": "my-project",
  "instance_id": "my-instance",
  "query": "SELECT * FROM purchases WHERE user_id = @user_id",
  "parameters": {"user_id": "u-123"},
  "parameter_types": {"user_id": "string"}
}
```

Every name in `parameters` needs an entry in `parameter_types`, and the reverse.
The Bigtable client builds each value from its declared type and rejects the
whole query if the two disagree, so `execute_sql` checks it first and names the
parameter at fault.

The declarable types are `bool`, `bytes`, `float32`, `float64`, `int64` and
`string`. A model emits JSON, so `execute_sql` converts on the way in: an
`int64` may be a whole number or a decimal string, and `bytes` must be base64.

GoogleSQL's `date` and `timestamp` are not declarable. The client builds them
only from its own `BigtableDate` and `PreciseDate` instances, and neither class
is reachable from the `@google-cloud/bigtable` entry point. Compare against a
literal in the query text instead.

## What is not here

adk-python's toolset has an eighth tool, `execute_sql_parameterized`, which
scopes a [parameterized
view](https://cloud.google.com/bigtable/docs/parameterized-views) to the caller
by passing `view_parameters` to the client. `@google-cloud/bigtable` has no
equivalent option, in 6.5.1 or in 7.2.0, so that tool is not ported. Binding the
value as an ordinary query parameter would not stand in for it: the model writes
the query text and can simply leave the predicate out.
