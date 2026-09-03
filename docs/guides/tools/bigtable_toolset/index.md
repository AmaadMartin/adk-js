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

`getTools()` returns these names as they are. The toolset also carries the
prefix `bigtable`, which matches `tool_name_prefix` in adk-python and is what
the framework will prepend once it applies toolset prefixes itself.

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

## Scoping a query to the caller

A model can put any value it likes into a query parameter, so a query that
filters on `user_id` does not stop the model reading another user's rows.
Bigtable answers this with a parameterized view, and `BigtableToolset` supplies
the value the view filters on.

Create the view with `VIEW_PARAMETERS`:

```sql
SELECT * FROM purchases WHERE user_id = VIEW_PARAMETERS('user_id')
```

Then name the parameter on the toolset:

```ts
new BigtableToolset({viewParameterNames: ['user_id']});
```

This adds an eighth tool, `execute_sql_parameterized`. It takes the same
arguments as `execute_sql`, and `user_id` is not one of them: the tool reads it
from the invocation on every call, and merges it in after the model's own
parameters, so a model-supplied `user_id` cannot win.

A name is resolved from the invocation when it is `user_id`, `session_id`,
`invocation_id` or `agent_name` — or their camelCase spellings. Any other name
is read from session state. A name that resolves nowhere is left out, and the
query then fails at Bigtable rather than running unfiltered.
