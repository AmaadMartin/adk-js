# Spanner tool settings

Describes what Spanner tools are allowed to do and how they return results.
Reach for it when you configure a Spanner toolset, or when you set up a Spanner
vector store for similarity search.

## Introduction

`SpannerToolSettings` is the configuration surface the Spanner tools read. It
carries three things: the capabilities a tool may exercise, the shape of a query
result, and the optional vector store a similarity search runs against. The
settings hold data only. They open no connection and read no credentials.

The capability list is the important part. It defaults to
`[SpannerCapabilities.DATA_READ]`, so a tool that reads the settings performs
read operations only. This default may change in future versions. A Spanner
admin toolset does not consult this field; constructing it exposes its instance
and database creation tools whatever is set here.

You build the settings with factory functions rather than object literals. A
factory applies the defaults and runs the validation, so the object you get back
is complete. `createSpannerToolSettings` also checks the
`SPANNER_TOOL_SETTINGS` feature flag, which is experimental and on by default.
Disabling the flag makes the factory throw.

The `@google/adk` barrel is flat, so three names carry a `Spanner` prefix there:
`SpannerCapabilities`, `SpannerQueryResultMode` and `SpannerTableColumn`. The
module itself keeps the adk-python names.

## Get started

```ts
import {
  SpannerCapabilities,
  SpannerQueryResultMode,
  createSpannerToolSettings,
} from '@google/adk';

// Defaults: read-only, 50 rows, DEFAULT result mode.
const settings = createSpannerToolSettings();

const custom = createSpannerToolSettings({
  capabilities: [SpannerCapabilities.DATA_READ],
  maxExecutedQueryResultRows: 100,
  queryResultMode: SpannerQueryResultMode.DICT_LIST,
  databaseRole: 'analyst',
});
```

`SpannerQueryResultMode.DEFAULT` returns each row as a list of values.
`SpannerQueryResultMode.DICT_LIST` returns each row as an object keyed by column name.

## Vector store settings

`createSpannerVectorStoreSettings` describes the table a similarity search runs
against. Eight fields are required; the rest carry defaults.

```ts
import {createSpannerVectorStoreSettings} from '@google/adk';

const vectorStore = createSpannerVectorStoreSettings({
  projectId: 'my-project',
  instanceId: 'my-instance',
  databaseId: 'my-db',
  tableName: 'documents',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
});

vectorStore.selectedColumns; // ['content']
vectorStore.topK; // 4
vectorStore.distanceType; // 'COSINE'
vectorStore.nearestNeighborsAlgorithm; // 'EXACT_NEAREST_NEIGHBORS'
```

`selectedColumns` defaults to the content column alone. `distanceType` accepts
`COSINE`, `DOT_PRODUCT` or `EUCLIDEAN`.

Pass the vector store to the tool settings. The outer factory routes it through
the inner one, so the defaults and the validation apply either way.

```ts
const settings = createSpannerToolSettings({vectorStoreSettings: vectorStore});
```

## Approximate nearest neighbors

`EXACT_NEAREST_NEIGHBORS` scans every row. `APPROXIMATE_NEAREST_NEIGHBORS` uses
a vector index instead, which needs
`createVectorSearchIndexSettings` to describe that index.

```ts
import {
  APPROXIMATE_NEAREST_NEIGHBORS,
  createSpannerVectorStoreSettings,
} from '@google/adk';

const approximate = createSpannerVectorStoreSettings({
  projectId: 'my-project',
  instanceId: 'my-instance',
  databaseId: 'my-db',
  tableName: 'documents',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
  nearestNeighborsAlgorithm: APPROXIMATE_NEAREST_NEIGHBORS,
  numLeavesToSearch: 100,
  vectorSearchIndexSettings: {indexName: 'documents_by_embedding'},
});

approximate.vectorSearchIndexSettings?.treeDepth; // 2
approximate.vectorSearchIndexSettings?.numLeaves; // 1000
```

For the algorithms, see
[exact nearest neighbors](https://docs.cloud.google.com/spanner/docs/find-k-nearest-neighbors)
and
[approximate nearest neighbors](https://docs.cloud.google.com/spanner/docs/find-approximate-nearest-neighbors).
For the index, see
[vector indexes](https://docs.cloud.google.com/spanner/docs/vector-indexes).

## Failure modes

`createSpannerVectorStoreSettings` throws a plain `Error` in three cases.

- A required field holds an empty string:
  `Missing required field 'projectId' in the Spanner vector store settings.`
- `vectorLength` is not a finite number above zero:
  `Invalid vector length in the Spanner vector store settings.`
- A `primaryKeyColumns` entry names no known column:
  `Primary key column 'x' not found in column definitions.` A primary key must
  name the content column, the embedding column, or a column listed in
  `additionalColumnsToSetup`.

The vector length is checked before the primary keys, so an object with both
problems reports the vector length.

`createSpannerToolSettings` throws
`Feature SPANNER_TOOL_SETTINGS is not enabled.` when the feature is off. Turn it
off with `ADK_DISABLE_SPANNER_TOOL_SETTINGS=1`, or with
`overrideFeatureEnabled(FeatureName.SPANNER_TOOL_SETTINGS, false)`.
