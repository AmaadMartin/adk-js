/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Capabilities,
  QueryResultMode,
  ReadonlyContext,
  SpannerCredentialsConfig,
  SpannerTool,
  SpannerToolset,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createToolContext} from './spanner_test_utils.js';

const DEFAULT_TOOL_NAMES = [
  'spanner_list_table_names',
  'spanner_list_table_indexes',
  'spanner_list_table_index_columns',
  'spanner_list_named_schemas',
  'spanner_get_table_schema',
  'spanner_execute_sql',
  'spanner_similarity_search',
];

const vectorStoreSettings = new SpannerVectorStoreSettings({
  projectId: 'p',
  instanceId: 'i',
  databaseId: 'd',
  tableName: 'documents',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
});

function names(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('SpannerToolset', () => {
  it('exposes the seven default tools under the spanner prefix', async () => {
    const tools = await new SpannerToolset().getTools();
    expect(names(tools)).toEqual(DEFAULT_TOOL_NAMES);
  });

  it('builds every tool as a SpannerTool', async () => {
    const tools = await new SpannerToolset().getTools();
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(SpannerTool);
    }
  });

  it('uses default settings when none are supplied', async () => {
    const [executeSql] = (await new SpannerToolset().getTools()).filter(
      (tool) => tool.name === 'spanner_execute_sql',
    );
    expect(executeSql?.description).toContain('list of its column values');
  });

  it('uses the supplied settings', async () => {
    const toolset = new SpannerToolset({
      spannerToolSettings: new SpannerToolSettings({
        queryResultMode: QueryResultMode.DICT_LIST,
      }),
    });
    const [executeSql] = (await toolset.getTools()).filter(
      (tool) => tool.name === 'spanner_execute_sql',
    );
    expect(executeSql?.description).toContain('keyed by column name');
  });

  it('adds the vector store tool when the settings carry a vector store', async () => {
    const toolset = new SpannerToolset({
      spannerToolSettings: new SpannerToolSettings({vectorStoreSettings}),
    });
    expect(names(await toolset.getTools())).toEqual([
      ...DEFAULT_TOOL_NAMES,
      'spanner_vector_store_similarity_search',
    ]);
  });

  it('exposes only the metadata tools without the data read capability', async () => {
    const toolset = new SpannerToolset({
      spannerToolSettings: new SpannerToolSettings({capabilities: []}),
    });
    expect(names(await toolset.getTools())).toEqual(
      DEFAULT_TOOL_NAMES.slice(0, 5),
    );
  });

  it('omits the vector store tool without the data read capability', async () => {
    const toolset = new SpannerToolset({
      spannerToolSettings: new SpannerToolSettings({
        capabilities: [],
        vectorStoreSettings,
      }),
    });
    expect(names(await toolset.getTools())).not.toContain(
      'spanner_vector_store_similarity_search',
    );
  });

  it('accepts credentials configuration', async () => {
    const toolset = new SpannerToolset({
      credentialsConfig: new SpannerCredentialsConfig({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    });
    expect(names(await toolset.getTools())).toEqual(DEFAULT_TOOL_NAMES);
  });

  describe('tool filter', () => {
    it('selects no tool for an empty array', async () => {
      const toolset = new SpannerToolset({toolFilter: []});
      expect(await toolset.getTools()).toEqual([]);
    });

    it('selects the named tools, matching the unprefixed name', async () => {
      const toolset = new SpannerToolset({
        toolFilter: ['list_table_names', 'get_table_schema'],
      });
      expect(names(await toolset.getTools())).toEqual([
        'spanner_list_table_names',
        'spanner_get_table_schema',
      ]);
    });

    it('selects a data read tool by name', async () => {
      const toolset = new SpannerToolset({toolFilter: ['execute_sql']});
      expect(names(await toolset.getTools())).toEqual(['spanner_execute_sql']);
    });

    it('selects nothing for an unknown name', async () => {
      const toolset = new SpannerToolset({toolFilter: ['unknown']});
      expect(await toolset.getTools()).toEqual([]);
    });

    it('ignores an unknown name alongside a known one', async () => {
      const toolset = new SpannerToolset({
        toolFilter: ['unknown', 'execute_sql'],
      });
      expect(names(await toolset.getTools())).toEqual(['spanner_execute_sql']);
    });

    it('does not match the prefixed name', async () => {
      const toolset = new SpannerToolset({
        toolFilter: ['spanner_execute_sql'],
      });
      expect(await toolset.getTools()).toEqual([]);
    });

    it('drops a data read tool the capabilities already removed', async () => {
      const toolset = new SpannerToolset({
        toolFilter: ['execute_sql', 'list_table_names'],
        spannerToolSettings: new SpannerToolSettings({capabilities: []}),
      });
      expect(names(await toolset.getTools())).toEqual([
        'spanner_list_table_names',
      ]);
    });

    it('keeps both metadata tools without the data read capability', async () => {
      const toolset = new SpannerToolset({
        toolFilter: ['list_table_names', 'list_table_indexes'],
        spannerToolSettings: new SpannerToolSettings({capabilities: []}),
      });
      expect(names(await toolset.getTools())).toEqual([
        'spanner_list_table_names',
        'spanner_list_table_indexes',
      ]);
    });

    it('evaluates a predicate without a context', async () => {
      const seen: Array<ReadonlyContext | undefined> = [];
      const toolset = new SpannerToolset({
        toolFilter: (tool, context) => {
          seen.push(context);
          return tool.name === 'spanner_list_named_schemas';
        },
      });
      expect(names(await toolset.getTools())).toEqual([
        'spanner_list_named_schemas',
      ]);
      expect(seen).toHaveLength(7);
      expect(seen.every((context) => context === undefined)).toBe(true);
    });

    it('passes the context to a predicate when one is given', async () => {
      const seen: Array<ReadonlyContext | undefined> = [];
      const context = createToolContext();
      const toolset = new SpannerToolset({
        toolFilter: (_tool, given) => {
          seen.push(given);
          return false;
        },
      });
      expect(await toolset.getTools(context)).toEqual([]);
      expect(seen.every((given) => given === context)).toBe(true);
    });
  });

  it('returns an equivalent list on every call', async () => {
    const toolset = new SpannerToolset();
    expect(names(await toolset.getTools())).toEqual(
      names(await toolset.getTools()),
    );
  });

  it('closes without side effects', async () => {
    await expect(new SpannerToolset().close()).resolves.toBeUndefined();
  });

  it('keeps the data read capability enumerable', () => {
    expect(new SpannerToolSettings().capabilities).toContain(
      Capabilities.DATA_READ,
    );
  });
});
