# SpannerToolset

`SpannerToolset` gives an agent read access to a Cloud Spanner database. It
exposes tools that list tables, describe a table's schema and indexes, run a
read-only SQL query, and search a table by vector similarity. Reach for it when
the agent has to answer questions from data that already lives in Spanner.

## Introduction

An agent that needs Spanner data has two problems. It does not know the shape
of the database, and it must not be able to change it. `SpannerToolset` solves
both. The metadata tools let the model discover tables, columns and indexes
before it writes a query, and every tool runs read-only, so no model output can
mutate a row.

The toolset is an aggregator: its value is the set of tools it composes and the
switches that decide which of them the model ever sees. The metadata tools are
always present. The data-reading tools appear only when the settings carry the
`DATA_READ` capability, and the vector store tool only when the settings carry
a vector store. A `toolFilter` narrows the set further, by name or by
predicate.

`@google-cloud/spanner` is an optional peer dependency. It is loaded on first
use, so an application that never builds a `SpannerToolset` never downloads it.
Install it alongside `@google/adk` when you use these tools:

```sh
npm install @google-cloud/spanner
```

Every tool answers with `{status: 'SUCCESS', ...}` or
`{status: 'ERROR', error_details}`. No tool throws at the model, so a bad query
or an unreachable database comes back as a result the model can read and react
to.

## Get started

```ts
import {LlmAgent, SpannerToolset} from '@google/adk';

const agent = new LlmAgent({
  name: 'spanner_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer questions about the Spanner database. Discover the schema first.',
  tools: [new SpannerToolset()],
});
```

With no options the toolset uses application default credentials and exposes
seven tools: `spanner_list_table_names`, `spanner_list_table_indexes`,
`spanner_list_table_index_columns`, `spanner_list_named_schemas`,
`spanner_get_table_schema`, `spanner_execute_sql` and
`spanner_similarity_search`.

## Choosing the tools

Turn the data-reading tools off by clearing the capabilities. The five metadata
tools remain:

```ts
import {SpannerToolset, SpannerToolSettings} from '@google/adk';

new SpannerToolset({
  spannerToolSettings: new SpannerToolSettings({capabilities: []}),
});
```

Select a subset by name. The filter matches the name **without** the `spanner_`
prefix, and the model still sees the prefixed name:

```ts
new SpannerToolset({toolFilter: ['execute_sql', 'list_table_names']});
```

An empty array selects nothing. Omit `toolFilter` to expose every tool.

A predicate decides per tool, and receives the tool under its prefixed name:

```ts
new SpannerToolset({
  toolFilter: (tool) => tool.name.startsWith('spanner_list_'),
});
```

## Query results

`spanner_execute_sql` returns at most `maxExecutedQueryResultRows` rows, 50 by
default. When it stops at the cap it adds `result_is_likely_truncated: true`,
so the model knows more rows match:

```ts
import {
  QueryResultMode,
  SpannerToolset,
  SpannerToolSettings,
} from '@google/adk';

new SpannerToolset({
  spannerToolSettings: new SpannerToolSettings({
    maxExecutedQueryResultRows: 100,
    queryResultMode: QueryResultMode.DICT_LIST,
    databaseRole: 'reader',
  }),
});
```

`QueryResultMode.DEFAULT` returns each row as the list of its column values.
`QueryResultMode.DICT_LIST` returns each row as an object keyed by column name,
which costs more tokens but is easier for a model to read. `databaseRole` sets
the Spanner database role the session runs as.

## Vector similarity search

`spanner_similarity_search` embeds a text query and returns the closest rows of
a table. The model supplies the table, the embedding column, the columns to
return, and how to embed. Exactly one embedding option must be set:
`vertex_ai_embedding_model_name` (a public Vertex AI model, either dialect),
`spanner_googlesql_embedding_model_name` (a model registered in a GoogleSQL
database) or `spanner_postgresql_vertex_ai_embedding_model_endpoint` (a Vertex
AI endpoint, PostgreSQL only).

To point the agent at one fixed vector store instead, configure it. That adds
`spanner_vector_store_similarity_search`, whose only parameter is the query:

```ts
import {
  SpannerToolset,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
} from '@google/adk';

new SpannerToolset({
  spannerToolSettings: new SpannerToolSettings({
    vectorStoreSettings: new SpannerVectorStoreSettings({
      projectId: process.env.SPANNER_PROJECT_ID!,
      instanceId: process.env.SPANNER_INSTANCE_ID!,
      databaseId: process.env.SPANNER_DATABASE_ID!,
      tableName: 'documents',
      contentColumn: 'content',
      embeddingColumn: 'content_embedding',
      vectorLength: 768,
      vertexAiEmbeddingModelName: 'text-embedding-005',
      topK: 4,
    }),
  }),
});
```

The table, the columns and the filter reach the generated SQL by
concatenation, and the model chooses them. They are therefore checked against
an allow-list first: an identifier must be alphanumerics, underscores and dots,
or be quoted with backticks or double quotes. `additional_filter` must be
comparisons, `LIKE`, `IS`, `IN` or `BETWEEN` joined by `AND` or `OR`, with up to
two levels of parentheses. Anything else comes back as an error result rather
than reaching the database.

## Authentication

With no `credentialsConfig` the tools use application default credentials.
Supply one to authenticate as the end user through OAuth:

```ts
import {SpannerCredentialsConfig, SpannerToolset} from '@google/adk';

new SpannerToolset({
  credentialsConfig: new SpannerCredentialsConfig({
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  }),
});
```

The first call returns a message asking the user to authorize, and the agent
raises the authorization request. Once the user consents, the token is cached
in the session state under `spanner_token_cache` and refreshed when it expires.
Two other sources are accepted, each mutually exclusive with the OAuth pair: an
existing `google-auth-library` client (`credentials`), or the session state key
holding an access token your application already obtained
(`externalAccessTokenKey`).

## Dialect support

`spanner_execute_sql`, `spanner_get_table_schema`,
`spanner_list_table_indexes`, `spanner_list_table_index_columns` and
`spanner_list_named_schemas` are GoogleSQL only. Against a PostgreSQL database
they return
`{status: 'ERROR', error_details: 'PostgreSQL dialect is not supported.'}`
rather than running.

The two similarity search tools support both dialects and generate different
SQL for each. `spanner_list_table_names` does not check the dialect: it queries
`INFORMATION_SCHEMA.TABLES` for the schema named in `named_schema`, which
defaults to the unnamed schema of a GoogleSQL database. Name the schema
explicitly for a PostgreSQL database.
