/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROXIMATE_NEAREST_NEIGHBORS,
  BaseTool,
  createVectorStoreSimilaritySearchTool,
  SpannerToolset,
  SpannerToolSettings,
  SpannerToolStatus,
  SpannerVectorStoreSettings,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {genaiFake, resetGenaiFake} from './genai_test_utils.js';
import {
  createToolContext,
  positionalRow,
  resetSpannerFake,
  respondTo,
  spannerFake,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const utils = await import('./spanner_test_utils.js');
  return utils.spannerModuleFake();
});

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  const {FakeGoogleGenAI} = await import('./genai_test_utils.js');
  return {...actual, GoogleGenAI: FakeGoogleGenAI};
});

const VERTEX_MODEL = {vertex_ai_embedding_model_name: 'text-embedding-005'};

const SEARCH_ARGS = {
  project_id: 'my-project',
  instance_id: 'my-instance',
  database_id: 'my-database',
  table_name: 'documents',
  query: 'cleaning tools',
  embedding_column_to_search: 'embedding',
  columns: ['title', 'body'],
  embedding_options: VERTEX_MODEL,
};

const vectorStoreSettings = new SpannerVectorStoreSettings({
  projectId: 'store-project',
  instanceId: 'store-instance',
  databaseId: 'store-database',
  tableName: 'store_documents',
  contentColumn: 'content',
  embeddingColumn: 'content_embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
});

async function toolNamed(
  name: string,
  settings = new SpannerToolSettings(),
): Promise<BaseTool> {
  const tools = await new SpannerToolset({
    spannerToolSettings: settings,
  }).getTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`no tool named ${name}`);
  }
  return tool;
}

async function search(
  args: Record<string, unknown>,
  settings?: SpannerToolSettings,
): Promise<unknown> {
  const tool = await toolNamed('spanner_similarity_search', settings);
  return tool.runAsync({args, toolContext: createToolContext()});
}

/** The search SQL, with its whitespace collapsed so it can be matched. */
function searchSql(): string {
  const query = spannerFake.queries.at(-1);
  if (!query) {
    expect.fail('the tool sent no query');
  }
  return query.sql.replace(/\s+/g, ' ').trim();
}

describe('spanner_similarity_search with a Vertex AI embedding model', () => {
  beforeEach(() => {
    resetSpannerFake();
    resetGenaiFake();
    vi.stubEnv('GOOGLE_GENAI_API_KEY', 'test-api-key');
  });

  it('embeds the query and returns the matching rows', async () => {
    respondTo(/COSINE_DISTANCE/, [
      positionalRow('Mop', 'Cleans floors.', 0.31),
      positionalRow('Vacuum', 'Cleans carpets.', 0.45),
    ]);

    await expect(search(SEARCH_ARGS)).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [
        ['Mop', 'Cleans floors.', 0.31],
        ['Vacuum', 'Cleans carpets.', 0.45],
      ],
    });
    expect(genaiFake.calls).toEqual([
      {
        model: 'text-embedding-005',
        contents: ['cleaning tools'],
        config: {},
      },
    ]);
  });

  it('generates a kNN query with the default top k and distance type', async () => {
    await search(SEARCH_ARGS);

    expect(searchSql()).toBe(
      'SELECT title, body, COSINE_DISTANCE(embedding, @embedding) AS distance ' +
        'FROM documents WHERE 1=1 ORDER BY distance LIMIT 4',
    );
    expect(spannerFake.queries.at(-1)?.params).toEqual({
      embedding: [0.1, 0.2, 0.3],
    });
  });

  it('applies the search options', async () => {
    await search({
      ...SEARCH_ARGS,
      search_options: {top_k: 2, distance_type: 'EUCLIDEAN'},
    });

    expect(searchSql()).toContain('EUCLIDEAN_DISTANCE(embedding, @embedding)');
    expect(searchSql()).toContain('LIMIT 2');
  });

  it('accepts a numeric option the model emitted as a string', async () => {
    await search({...SEARCH_ARGS, search_options: {top_k: '7'}});

    expect(searchSql()).toContain('LIMIT 7');
  });

  it('omits the limit for a top k of zero', async () => {
    await search({...SEARCH_ARGS, search_options: {top_k: 0}});

    expect(searchSql()).not.toContain('LIMIT');
  });

  it('applies an additional filter to the where clause', async () => {
    await search({...SEARCH_ARGS, additional_filter: 'price < 100000'});

    expect(searchSql()).toContain('WHERE price < 100000');
  });

  it('passes the output dimensionality to the embedding model', async () => {
    await search({
      ...SEARCH_ARGS,
      embedding_options: {...VERTEX_MODEL, output_dimensionality: '256'},
    });

    expect(genaiFake.calls[0]?.config).toEqual({outputDimensionality: 256});
  });

  it('generates an approximate query when asked for one', async () => {
    await search({
      ...SEARCH_ARGS,
      search_options: {
        nearest_neighbors_algorithm: APPROXIMATE_NEAREST_NEIGHBORS,
        num_leaves_to_search: 40,
        top_k: 3,
      },
    });

    expect(searchSql()).toBe(
      'SELECT title, body, APPROX_COSINE_DISTANCE(embedding, @embedding,' +
        ' options => JSON \'{"num_leaves_to_search": 40}\') AS distance ' +
        'FROM documents WHERE embedding IS NOT NULL ORDER BY distance LIMIT 3',
    );
  });

  it('defaults the number of leaves an approximate query searches', async () => {
    await search({
      ...SEARCH_ARGS,
      search_options: {
        nearest_neighbors_algorithm: APPROXIMATE_NEAREST_NEIGHBORS,
      },
    });

    expect(searchSql()).toContain('"num_leaves_to_search": 1000');
  });

  it('combines the embedding guard with an additional filter', async () => {
    await search({
      ...SEARCH_ARGS,
      additional_filter: 'price < 100000',
      search_options: {
        nearest_neighbors_algorithm: APPROXIMATE_NEAREST_NEIGHBORS,
      },
    });

    expect(searchSql()).toContain(
      'WHERE embedding IS NOT NULL AND price < 100000',
    );
  });

  it('rejects an approximate query against a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(
      search({
        ...SEARCH_ARGS,
        search_options: {
          nearest_neighbors_algorithm: APPROXIMATE_NEAREST_NEIGHBORS,
        },
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details:
        'APPROXIMATE_NEAREST_NEIGHBORS is not supported for PostgreSQL dialect.',
    });
  });

  it('names the parameter PostgreSQL expects', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await search(SEARCH_ARGS);

    expect(searchSql()).toContain('spanner.cosine_distance(embedding, $1)');
    expect(spannerFake.queries.at(-1)?.params).toEqual({p1: [0.1, 0.2, 0.3]});
  });

  it('reports an unsupported nearest neighbors algorithm', async () => {
    await expect(
      search({
        ...SEARCH_ARGS,
        search_options: {nearest_neighbors_algorithm: 'BRUTE_FORCE'},
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details:
        "Unsupported search_options['nearest_neighbors_algorithm']: BRUTE_FORCE",
    });
  });

  it('reports an unsupported distance type', async () => {
    await expect(
      search({...SEARCH_ARGS, search_options: {distance_type: 'MANHATTAN'}}),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Unsupported distance type: MANHATTAN.',
    });
  });

  it('reports an option that is not an integer', async () => {
    await expect(
      search({...SEARCH_ARGS, search_options: {top_k: 'many'}}),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: "Option 'top_k' must be an integer, got many.",
    });
  });

  it.each([
    ['an empty string', ''],
    ['a boolean', true],
  ])('reports an integer option given as %s', async (_label, value) => {
    await expect(
      search({...SEARCH_ARGS, search_options: {top_k: value}}),
    ).resolves.toMatchObject({
      status: SpannerToolStatus.ERROR,
      error_details: expect.stringContaining(
        "Option 'top_k' must be an integer",
      ),
    });
  });

  it('reports an option that is not a string', async () => {
    await expect(
      search({...SEARCH_ARGS, search_options: {distance_type: 7}}),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: "Option 'distance_type' must be a string, got 7.",
    });
  });

  it('reports a failure to embed the query', async () => {
    genaiFake.error = new Error('quota exhausted');

    await expect(search(SEARCH_ARGS)).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Failed to embed content: quota exhausted',
    });
  });

  it('reports an embedding response with no values', async () => {
    genaiFake.embedding = undefined;

    await expect(search(SEARCH_ARGS)).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details:
        'Failed to embed content: the response carried no embedding.',
    });
  });

  it('builds a Vertex AI client when enterprise mode is on', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', '1');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    await search(SEARCH_ARGS);

    expect(genaiFake.clientOptions).toEqual([
      {vertexai: true, project: 'my-project', location: 'us-central1'},
    ]);
  });

  it('reports an unsupported database dialect', async () => {
    spannerFake.dialect = 'DATABASE_DIALECT_UNSPECIFIED';

    await expect(search(SEARCH_ARGS)).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details:
        'Unsupported database dialect: DATABASE_DIALECT_UNSPECIFIED',
    });
  });

  it('closes the client on the failure path', async () => {
    genaiFake.error = new Error('quota exhausted');

    await search(SEARCH_ARGS);

    expect(spannerFake.clients[0]?.closeCount).toBe(1);
    expect(spannerFake.databases[0]?.closeCount).toBe(1);
  });
});

describe('spanner_similarity_search input validation', () => {
  beforeEach(() => {
    resetSpannerFake();
    resetGenaiFake();
    vi.stubEnv('GOOGLE_GENAI_API_KEY', 'test-api-key');
  });

  it('rejects an unsafe table name', async () => {
    await expect(
      search({...SEARCH_ARGS, table_name: 'documents; DROP TABLE users'}),
    ).resolves.toMatchObject({
      status: SpannerToolStatus.ERROR,
      error_details: expect.stringContaining(
        'Invalid SQL identifier for table_name',
      ),
    });
    expect(spannerFake.clients).toEqual([]);
  });

  it('rejects an unsafe embedding column', async () => {
    await expect(
      search({...SEARCH_ARGS, embedding_column_to_search: 'a.b(c)$d'}),
    ).resolves.toMatchObject({
      error_details: expect.stringContaining(
        'Invalid SQL identifier for embedding_column_to_search',
      ),
    });
  });

  it('rejects an unsafe selected column', async () => {
    await expect(
      search({...SEARCH_ARGS, columns: ['title', '1; DROP TABLE users']}),
    ).resolves.toMatchObject({
      error_details: expect.stringContaining(
        'Invalid SQL identifier for columns',
      ),
    });
  });

  it('rejects an unsafe additional filter', async () => {
    await expect(
      search({...SEARCH_ARGS, additional_filter: '1=1; DROP TABLE users'}),
    ).resolves.toMatchObject({
      error_details: expect.stringContaining(
        'additional_filter contains unsafe or unsupported patterns',
      ),
    });
  });

  it('rejects an unsafe GoogleSQL embedding model name', async () => {
    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          spanner_googlesql_embedding_model_name: 'model); DROP TABLE users',
        },
      }),
    ).resolves.toMatchObject({
      error_details: expect.stringContaining(
        'Invalid SQL identifier for spanner_googlesql_embedding_model_name',
      ),
    });
  });

  it('rejects a malformed Vertex AI endpoint', async () => {
    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          spanner_postgresql_vertex_ai_embedding_model_endpoint: 'my-endpoint',
        },
      }),
    ).resolves.toMatchObject({
      error_details: expect.stringContaining(
        'Invalid Vertex AI endpoint format',
      ),
    });
  });

  it('requires an embedding model option', async () => {
    await expect(
      search({...SEARCH_ARGS, embedding_options: {}}),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Exactly one embedding model option must be specified.',
    });
  });

  it('rejects two embedding model options', async () => {
    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          ...VERTEX_MODEL,
          spanner_googlesql_embedding_model_name: 'embedding_model',
        },
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Exactly one embedding model option must be specified.',
    });
  });

  it('rejects a PostgreSQL endpoint against a GoogleSQL database', async () => {
    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          spanner_postgresql_vertex_ai_embedding_model_endpoint:
            'projects/p/locations/l/publishers/google/models/m',
        },
      }),
    ).resolves.toMatchObject({
      error_details:
        "embedding_options['vertex_ai_embedding_model_name'] or" +
        " embedding_options['spanner_googlesql_embedding_model_name'] must be" +
        ' specified for GoogleSQL dialect Spanner database.',
    });
  });

  it('rejects a GoogleSQL model against a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          spanner_googlesql_embedding_model_name: 'embedding_model',
        },
      }),
    ).resolves.toMatchObject({
      error_details:
        "embedding_options['vertex_ai_embedding_model_name'] or" +
        " embedding_options['spanner_postgresql_vertex_ai_embedding_model_endpoint']" +
        ' must be specified for PostgreSQL dialect Spanner database.',
    });
  });

  it('rejects an output dimensionality alongside a GoogleSQL model', async () => {
    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          spanner_googlesql_embedding_model_name: 'embedding_model',
          output_dimensionality: '256',
        },
      }),
    ).resolves.toMatchObject({
      error_details:
        'embedding_options[output_dimensionality] is not supported when' +
        " embedding_options['spanner_googlesql_embedding_model_name'] is" +
        ' specified.',
    });
  });
});

describe('spanner_similarity_search embedding inside Spanner', () => {
  beforeEach(() => {
    resetSpannerFake();
    resetGenaiFake();
  });

  it('embeds with ML.PREDICT in a GoogleSQL database', async () => {
    respondTo(/ML\.PREDICT/, [positionalRow([0.4, 0.5])]);

    await search({
      ...SEARCH_ARGS,
      embedding_options: {
        spanner_googlesql_embedding_model_name: 'embedding_model',
      },
    });

    const embeddingQuery = spannerFake.queries[0];
    expect(embeddingQuery?.sql.replace(/\s+/g, ' ')).toContain(
      'MODEL embedding_model',
    );
    expect(embeddingQuery?.params).toEqual({query: 'cleaning tools'});
    expect(spannerFake.queries.at(-1)?.params).toEqual({
      embedding: [0.4, 0.5],
    });
    expect(genaiFake.calls).toEqual([]);
  });

  it('embeds with ML_PREDICT_ROW in a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';
    respondTo(/ML_PREDICT_ROW/, [positionalRow([0.6])]);

    await search({
      ...SEARCH_ARGS,
      embedding_options: {
        spanner_postgresql_vertex_ai_embedding_model_endpoint:
          'projects/p/locations/l/publishers/google/models/m',
        output_dimensionality: '256',
      },
    });

    const embeddingQuery = spannerFake.queries[0];
    expect(embeddingQuery?.sql.replace(/\s+/g, ' ')).toContain(
      "'projects/p/locations/l/publishers/google/models/m'",
    );
    expect(embeddingQuery?.sql.replace(/\s+/g, ' ')).toContain(
      "'outputDimensionality', 256",
    );
    expect(embeddingQuery?.params).toEqual({p1: 'cleaning tools'});
  });

  it('omits the parameters block without an output dimensionality', async () => {
    spannerFake.dialect = 'POSTGRESQL';
    respondTo(/ML_PREDICT_ROW/, [positionalRow([0.6])]);

    await search({
      ...SEARCH_ARGS,
      embedding_options: {
        spanner_postgresql_vertex_ai_embedding_model_endpoint:
          'projects/p/locations/l/publishers/google/models/m',
      },
    });

    expect(spannerFake.queries[0]?.sql).not.toContain('outputDimensionality');
  });

  it('reports an embedding query that returned nothing', async () => {
    respondTo(/ML\.PREDICT/, []);

    await expect(
      search({
        ...SEARCH_ARGS,
        embedding_options: {
          spanner_googlesql_embedding_model_name: 'embedding_model',
        },
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'The embedding query returned no rows.',
    });
  });
});

describe('spanner_vector_store_similarity_search', () => {
  beforeEach(() => {
    resetSpannerFake();
    resetGenaiFake();
    vi.stubEnv('GOOGLE_GENAI_API_KEY', 'test-api-key');
  });

  async function searchVectorStore(
    settings: SpannerToolSettings,
  ): Promise<unknown> {
    const tool = await toolNamed(
      'spanner_vector_store_similarity_search',
      settings,
    );
    return tool.runAsync({
      args: {query: 'schema design'},
      toolContext: createToolContext(),
    });
  }

  it('searches the configured vector store', async () => {
    respondTo(/COSINE_DISTANCE/, [positionalRow('Schema design', 0.2)]);

    await expect(
      searchVectorStore(new SpannerToolSettings({vectorStoreSettings})),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [['Schema design', 0.2]],
    });
    expect(searchSql()).toBe(
      'SELECT content, COSINE_DISTANCE(content_embedding, @embedding) AS distance ' +
        'FROM store_documents WHERE 1=1 ORDER BY distance LIMIT 4',
    );
    expect(genaiFake.calls[0]?.config).toEqual({outputDimensionality: 768});
  });

  it('opens the vector store database, not the caller-supplied one', async () => {
    await searchVectorStore(new SpannerToolSettings({vectorStoreSettings}));

    expect(spannerFake.clients[0]?.options['projectId']).toBe('store-project');
    expect(spannerFake.databases[0]?.databaseId).toBe('store-database');
  });

  it('applies the vector store search settings', async () => {
    const settings = new SpannerToolSettings({
      vectorStoreSettings: new SpannerVectorStoreSettings({
        projectId: 'store-project',
        instanceId: 'store-instance',
        databaseId: 'store-database',
        tableName: 'store_documents',
        contentColumn: 'content',
        embeddingColumn: 'content_embedding',
        vectorLength: 768,
        vertexAiEmbeddingModelName: 'text-embedding-005',
        selectedColumns: ['content', 'title'],
        topK: 2,
        distanceType: 'DOT_PRODUCT',
        additionalFilter: 'category = 1',
      }),
    });

    await searchVectorStore(settings);

    expect(searchSql()).toBe(
      'SELECT content, title, DOT_PRODUCT(content_embedding, @embedding) AS distance ' +
        'FROM store_documents WHERE category = 1 ORDER BY distance LIMIT 2',
    );
  });

  it('passes the number of leaves for an approximate search', async () => {
    const settings = new SpannerToolSettings({
      vectorStoreSettings: new SpannerVectorStoreSettings({
        projectId: 'store-project',
        instanceId: 'store-instance',
        databaseId: 'store-database',
        tableName: 'store_documents',
        contentColumn: 'content',
        embeddingColumn: 'content_embedding',
        vectorLength: 768,
        vertexAiEmbeddingModelName: 'text-embedding-005',
        nearestNeighborsAlgorithm: APPROXIMATE_NEAREST_NEIGHBORS,
        numLeavesToSearch: 25,
      }),
    });

    await searchVectorStore(settings);

    expect(searchSql()).toContain('"num_leaves_to_search": 25');
  });

  it('reports missing vector store settings', async () => {
    // The toolset only exposes this tool when a vector store is configured,
    // so the guard is reached by building the tool without one.
    const tool = createVectorStoreSimilaritySearchTool({
      toolSettings: new SpannerToolSettings(),
    });

    await expect(
      tool.runAsync({
        args: {query: 'schema design'},
        toolContext: createToolContext(),
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Spanner vector store settings are not set.',
    });
    expect(spannerFake.clients).toEqual([]);
  });
});
