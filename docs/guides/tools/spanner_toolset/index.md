# SpannerToolset

`SpannerToolset` gives an agent read-only access to a Cloud Spanner database:
it can list the tables, read a table's schema and indexes, run a SQL query, and
find the rows whose embedding column is closest to a piece of text. Reach for
it when the answer the user wants is in Spanner and you do not want to write a
tool per question.

## Introduction

An agent that must answer questions about live data needs two things: a way to
discover what the data looks like, and a way to read it. This toolset supplies
both, so a model can inspect `INFORMATION_SCHEMA` first and then write a query
against what it found.

Nothing the toolset does writes. Every statement runs in a read-only snapshot,
and there is no tool that changes data or schema. The row budget bounds what a
single query returns, so a mistaken `SELECT *` cannot flood the context window.

Two things need care because a model, not you, fills them in. The query text of
`spanner_execute_sql` is sent to Spanner as written, which is why the toolset
refuses to run anything but a read. The table name, column names and filter of
`spanner_similarity_search` are interpolated into generated SQL, so each is
checked against an allowlist grammar before a connection is opened.

`SpannerToolset` reads data. Instance and database administration is a
different concern and is not part of it.

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
  SpannerToolset,
} from '@google/adk/tools/spanner';
import {GoogleAuth} from 'google-auth-library';

const authClient = await new GoogleAuth({
  scopes: [...SPANNER_DEFAULT_SCOPES],
}).getClient();

const agent = new LlmAgent({
  name: 'dba',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the orders database.',
  tools: [new SpannerToolset({credentialsConfig: {authClient}})],
});
```

That agent gets seven tools:

| Tool                               | What it reads                          |
| ---------------------------------- | -------------------------------------- |
| `spanner_list_table_names`         | the tables of one schema               |
| `spanner_list_named_schemas`       | the named schemas of the database      |
| `spanner_get_table_schema`         | one table's columns, keys and metadata |
| `spanner_list_table_indexes`       | one table's indexes                    |
| `spanner_list_table_index_columns` | the columns of those indexes           |
| `spanner_execute_sql`              | the rows a query selects               |
| `spanner_similarity_search`        | the rows nearest to a text query       |

Every tool answers with `{status: 'SUCCESS', ...}` or
`{status: 'ERROR', error_details}`. A tool never throws, so a rejected query
reaches the model as a message it can react to.

## Credentials

`credentialsConfig` takes exactly one of three shapes.

```ts
// 1. One identity for every end user.
new SpannerToolset({credentialsConfig: {authClient}});

// 2. A token another component already minted, read from session state.
new SpannerToolset({
  credentialsConfig: {externalAccessTokenKey: 'spanner_token'},
});

// 3. Each end user acting as themselves, through the OAuth flow.
new SpannerToolset({
  credentialsConfig: {
    clientId: process.env.SPANNER_OAUTH_CLIENT_ID,
    clientSecret: process.env.SPANNER_OAUTH_CLIENT_SECRET,
  },
});
```

The constructor rejects a config that names none of them, or more than one.

With the OAuth flow, the first tool call asks the user to authorize and answers
`ERROR` with a message saying so. The resolved token is cached in that user's
session state, so later calls in the same session go straight through.

## Settings

```ts
import {
  Capabilities,
  QueryResultMode,
  SpannerToolset,
} from '@google/adk/tools/spanner';

new SpannerToolset({
  credentialsConfig: {authClient},
  spannerToolSettings: {
    capabilities: [Capabilities.DATA_READ],
    maxExecutedQueryResultRows: 100,
    queryResultMode: QueryResultMode.DICT_LIST,
    databaseRole: 'analyst',
  },
});
```

- `capabilities` defaults to `[Capabilities.DATA_READ]`. Setting it to `[]`
  leaves only the five metadata tools, so the agent can describe the database
  but not read it.
- `maxExecutedQueryResultRows` caps how many rows `spanner_execute_sql` reads,
  defaulting to 50. A value of zero or less falls back to 50. When the budget
  runs out the result carries `result_is_likely_truncated: true`.
- `queryResultMode` decides the row shape. `DEFAULT` returns each row as its
  list of column values; `DICT_LIST` returns an object keyed by column name.
  The tool's description tells the model which one it will get.
- `databaseRole` names the Spanner database role the query session runs as.
  Only `spanner_execute_sql` uses it, matching adk-python.

## Vector similarity search

`spanner_similarity_search` works against any table that holds an embedding
column. The model names the table, the embedding column and the columns to
return, and picks the embedding model:

```ts
// The model sends these arguments.
{
  project_id: 'my-project',
  instance_id: 'my-instance',
  database_id: 'my-database',
  table_name: 'products',
  query: 'tools that help me clean my house',
  embedding_column_to_search: 'description_embedding',
  columns: ['product_name', 'price_in_cents'],
  embedding_options: {vertex_ai_embedding_model_name: 'text-embedding-005'},
  additional_filter: 'price_in_cents < 100000',
  search_options: {top_k: 2, distance_type: 'COSINE'},
}
```

`embedding_options` must name exactly one embedding model, which decides where
the query vector is produced:

- `vertex_ai_embedding_model_name` embeds on the client through `@google/genai`,
  and works against either dialect.
- `spanner_googlesql_embedding_model_name` embeds inside a GoogleSQL database
  with `ML.PREDICT`, using a model registered by `CREATE MODEL`.
- `spanner_postgresql_vertex_ai_embedding_model_endpoint` embeds inside a
  PostgreSQL database with `spanner.ML_PREDICT_ROW`.

`search_options` accepts `top_k` (default 4), `distance_type` (`COSINE`,
`EUCLIDEAN` or `DOT_PRODUCT`, default `COSINE`),
`nearest_neighbors_algorithm` and, for the approximate algorithm,
`num_leaves_to_search` (default 1000). The approximate algorithm reads a vector
index and is GoogleSQL only.

### A configured vector store

When you already know which table holds the documents, configure it once and
the toolset adds an eighth tool that takes only the query text:

```ts
const toolset = new SpannerToolset({
  credentialsConfig: {authClient},
  spannerToolSettings: {
    vectorStoreSettings: {
      projectId: 'my-project',
      instanceId: 'my-instance',
      databaseId: 'my-database',
      tableName: 'documents',
      contentColumn: 'content',
      embeddingColumn: 'embedding',
      vectorLength: 768,
      vertexAiEmbeddingModelName: 'text-embedding-005',
      topK: 4,
    },
  },
});
```

`spanner_vector_store_similarity_search` then takes `{query}` alone. The
constructor rejects a vector store whose `vectorLength` is not positive. When
`selectedColumns` is absent, the search returns the content column.

## Dialects

The metadata tools query `INFORMATION_SCHEMA` with GoogleSQL syntax, so
`spanner_get_table_schema`, `spanner_list_table_indexes`,
`spanner_list_table_index_columns`, `spanner_list_named_schemas` and
`spanner_execute_sql` answer `ERROR` against a PostgreSQL dialect database.
`spanner_list_table_names` and both search tools work against either dialect.

## Tool filtering

`toolFilter` takes a list of names or a predicate, and both see the tool under
its prefixed name:

```ts
new SpannerToolset({
  credentialsConfig: {authClient},
  toolFilter: ['spanner_list_table_names', 'spanner_get_table_schema'],
});
```

This differs from adk-python, which filters on the bare name, so a filter
ported from Python needs the `spanner_` prefix added. It matches `MCPToolset`
and `OpenAPIToolset` in this package. A name no tool carries is ignored.

An empty list exposes no tools, as it does in adk-python. Omit `toolFilter` to
expose every tool.

## Resources

Each tool call builds its own Spanner client and closes it, along with the
database handle and the read snapshot, before it answers. A client is never
shared between calls, because the credentials belong to one end user and a
reused client would serve the next user under the previous user's identity.
`close()` on the toolset is therefore a no-op.
