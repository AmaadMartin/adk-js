# DataAgentToolset

Lets an agent ask a Conversational Analytics data agent questions in plain
language, and manage those data agents. Reach for it when the answer lives in
BigQuery and you want the model to ask for it rather than write the SQL.

## Introduction

A data agent is a Google Cloud resource that knows which tables it may read and
answers questions about them. `DataAgentToolset` gives your agent the tools to
find one, read its configuration and ask it a question. The data agent does the
schema reasoning and the SQL; your agent decides what to ask and how to present
the answer.

Three tools are always exposed. Three more appear only when you allow it,
because they change Google Cloud resources.

| Tool                          | What it does                              | Needs `enableDataAgentModification` |
| ----------------------------- | ----------------------------------------- | ----------------------------------- |
| `list_accessible_data_agents` | Lists the data agents a project can see   | no                                  |
| `get_data_agent_info`         | Reads one data agent by resource name     | no                                  |
| `ask_data_agent`              | Asks a data agent a question              | no                                  |
| `create_data_agent`           | Creates a data agent                      | yes                                 |
| `update_data_agent`           | Patches a data agent under an update mask | yes                                 |
| `delete_data_agent`           | Deletes a data agent                      | yes                                 |

The mutation gate defaults to off so a read-only toolset stays read-only. It is
enforced twice: the toolset does not build the three tools, and each one
refuses again when it is called. A tool you obtained directly, rather than
through `getTools()`, is still gated.

This is the TypeScript port of `google.adk.tools.data_agent` in adk-python. The
tool names, the request paths and the result keys match, so a prompt written
against one SDK behaves the same against the other.

No extra dependency is needed. The tools speak REST through `fetch`, authorized
by `google-auth-library`, which `@google/adk` already depends on.

## Get started

```ts
import {DataAgentToolset, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'data_agent',
  model: 'gemini-2.5-flash',
  instruction: "Answer questions about the user's data using data agents.",
  tools: [
    new DataAgentToolset({
      credentialsConfig: {
        clientId: process.env.OAUTH_CLIENT_ID,
        clientSecret: process.env.OAUTH_CLIENT_SECRET,
      },
      dataAgentToolConfig: {maxQueryResultRows: 100},
    }),
  ],
});
```

Then ask it something like:

- "List accessible data agents."
- "Using agent `projects/my-project/locations/global/dataAgents/sales-agent`,
  who were my top 3 customers last quarter?"

## Prerequisites

1. A Google Cloud project with the BigQuery and Gemini APIs enabled.
2. Application Default Credentials, if you authenticate that way:
   ```sh
   gcloud auth application-default login
   ```
3. At least one data agent. Create one through the
   [Conversational Analytics API](https://docs.cloud.google.com/gemini/docs/conversational-analytics-api/overview),
   or, for BigQuery data, in
   [BigQuery Studio](https://docs.cloud.google.com/bigquery/docs/create-data-agents#create_a_data_agent).
4. The IAM permissions the API's
   [setup guide](https://docs.cloud.google.com/gemini/docs/conversational-analytics-api/overview#setup)
   lists.

## Credentials

`credentialsConfig` accepts exactly one of three shapes. The constructor throws
when it names none, or more than one.

One identity for every end user, from Application Default Credentials or a
service-account key:

```ts
import {GoogleAuth} from 'google-auth-library';

const credentials = await new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/bigquery'],
}).getClient();
const toolset = new DataAgentToolset({credentialsConfig: {credentials}});
```

A token another component already minted and wrote to session state:

```ts
const toolset = new DataAgentToolset({
  credentialsConfig: {externalAccessTokenKey: 'my_access_token'},
});
```

An OAuth client, so each end user authorizes for themselves. The first call
answers with an authorization message and asks for the credential; the tool
runs once the user has completed the flow, and the token is cached in session
state under `data_agent_token_cache`.

```ts
const toolset = new DataAgentToolset({
  credentialsConfig: {clientId, clientSecret},
});
```

Omitting `credentialsConfig` sends the requests with no credential at all,
which only works against an endpoint that needs none.

## Configuration

| Field                                      | Default | What it does                                      |
| ------------------------------------------ | ------- | ------------------------------------------------- |
| `maxQueryResultRows`                       | `50`    | Rows a query result may carry                     |
| `location`                                 | derived | The location of the data agents, for example `eu` |
| `apiEndpoint`                              | derived | A host that replaces the derived one              |
| `dataAgentModificationTimeoutSeconds`      | `60`    | Total wait for a mutation                         |
| `dataAgentModificationPollIntervalSeconds` | `2`     | Wait between two polls                            |
| `enableDataAgentModification`              | `false` | Whether the mutation tools exist                  |

When neither `location` nor `apiEndpoint` is set, the location is read out of
the data agent's resource name, falling back to `global`. Both timing fields
must be greater than zero; the constructor throws otherwise.

## What a tool answers with

Every tool resolves to `{status: 'SUCCESS', response}` or
`{status: 'ERROR', error_details}`. No tool throws, so a failure reaches the
model as a result it can explain rather than as a broken turn.

`ask_data_agent` answers with the steps the data agent took. A step carrying
rows uses the `Data Retrieved` key, and only the newest one keeps its rows:

```json
{
  "status": "SUCCESS",
  "response": [
    {"text": {"parts": ["Reading the table"], "textType": "THOUGHT"}},
    {
      "Data Retrieved": {
        "headers": ["orders"],
        "rows": [[42]],
        "summary": "Showing all 1 rows."
      }
    }
  ]
}
```

## Creating and changing data agents

Set `enableDataAgentModification` to expose the three mutation tools:

```ts
const toolset = new DataAgentToolset({
  credentialsConfig: {credentials},
  dataAgentToolConfig: {enableDataAgentModification: true},
});
```

Each mutation starts a long-running operation, and the tool polls it until it
finishes or the timeout expires. A timeout is not a failure: the operation may
still be running, so the error carries `operation_name` so you can check on it
later.

`update_data_agent` rejects an `update_mask` field that `agent_config` does not
carry. The API clears a masked field the body omits, so a forgotten field would
silently destroy data.

## Regional endpoints

The location selects the host:

| Location          | Host                                           |
| ----------------- | ---------------------------------------------- |
| unset or `global` | `geminidataanalytics.googleapis.com`           |
| `eu` or `us`      | `geminidataanalytics.<loc>.rep.googleapis.com` |
| anything else     | `geminidataanalytics-<loc>.googleapis.com`     |

Setting `apiEndpoint` overrides all of it. A value with no scheme gets
`https://`.
