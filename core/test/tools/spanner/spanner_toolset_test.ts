/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, ReadonlyContext} from '@google/adk';
import {
  Capabilities,
  SpannerToolSettings,
  SpannerToolset,
  SpannerVectorStoreSettings,
} from '@google/adk/tools/spanner';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';
import {makeToolContext, testCredentialsConfig} from './spanner_test_utils.js';

const METADATA_TOOL_NAMES = [
  'spanner_list_table_names',
  'spanner_list_table_indexes',
  'spanner_list_table_index_columns',
  'spanner_list_named_schemas',
  'spanner_get_table_schema',
];

const VECTOR_STORE: SpannerVectorStoreSettings = {
  projectId: 'p',
  instanceId: 'i',
  databaseId: 'd',
  tableName: 'documents',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
};

function makeToolset(
  options: {
    settings?: SpannerToolSettings;
    toolFilter?: SpannerToolset['toolFilter'];
  } = {},
): SpannerToolset {
  return new SpannerToolset({
    credentialsConfig: testCredentialsConfig(),
    spannerToolSettings: options.settings,
    toolFilter: options.toolFilter,
  });
}

async function toolNames(
  toolset: SpannerToolset,
  context?: ReadonlyContext,
): Promise<string[]> {
  return (await toolset.getTools(context)).map((tool) => tool.name);
}

describe('SpannerToolset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes seven tools by default', async () => {
    expect(await toolNames(makeToolset())).toEqual([
      ...METADATA_TOOL_NAMES,
      'spanner_execute_sql',
      'spanner_similarity_search',
    ]);
  });

  it('describes every tool it exposes', async () => {
    const tools = await makeToolset().getTools();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('adds the vector store search when a vector store is configured', async () => {
    const toolset = makeToolset({
      settings: {vectorStoreSettings: VECTOR_STORE},
    });

    expect(await toolNames(toolset)).toEqual([
      ...METADATA_TOOL_NAMES,
      'spanner_execute_sql',
      'spanner_similarity_search',
      'spanner_vector_store_similarity_search',
    ]);
  });

  it('exposes only the metadata tools without the data-read capability', async () => {
    const toolset = makeToolset({settings: {capabilities: []}});

    expect(await toolNames(toolset)).toEqual(METADATA_TOOL_NAMES);
  });

  it('withholds the vector store search without the data-read capability', async () => {
    const toolset = makeToolset({
      settings: {capabilities: [], vectorStoreSettings: VECTOR_STORE},
    });

    expect(await toolNames(toolset)).toEqual(METADATA_TOOL_NAMES);
  });

  it('exposes the query tools when the capability is listed explicitly', async () => {
    const toolset = makeToolset({
      settings: {capabilities: [Capabilities.DATA_READ]},
    });

    expect(await toolNames(toolset)).toContain('spanner_execute_sql');
  });

  it('rejects a vector store the search could never use', () => {
    expect(() =>
      makeToolset({
        settings: {vectorStoreSettings: {...VECTOR_STORE, vectorLength: 0}},
      }),
    ).toThrow('Invalid vector length in the Spanner vector store settings.');
  });

  it('rejects credentials naming more than one source', () => {
    expect(
      () =>
        new SpannerToolset({
          credentialsConfig: {clientId: 'id', clientSecret: 'secret'},
          toolFilter: [],
        }),
    ).not.toThrow();
    expect(
      () =>
        new SpannerToolset({
          credentialsConfig: {clientId: 'id-without-secret'},
        }),
    ).toThrow(/Must provide one of credentials/);
  });

  describe('the tool filter', () => {
    it('returns no tool when it is empty, as adk-python does', async () => {
      expect(await toolNames(makeToolset({toolFilter: []}))).toEqual([]);
    });

    it('returns no tool when it is empty and a context is given', async () => {
      expect(
        await toolNames(makeToolset({toolFilter: []}), makeToolContext()),
      ).toEqual([]);
    });

    it('returns every tool when the option is absent', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      expect(await toolNames(makeToolset())).toHaveLength(7);
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns every tool when the option is absent and a context is given', async () => {
      expect(await toolNames(makeToolset(), makeToolContext())).toHaveLength(7);
    });

    it('keeps only the prefixed names it lists', async () => {
      const toolset = makeToolset({
        toolFilter: ['spanner_list_table_names', 'spanner_get_table_schema'],
      });

      expect(await toolNames(toolset)).toEqual([
        'spanner_list_table_names',
        'spanner_get_table_schema',
      ]);
    });

    it('keeps a single query tool', async () => {
      const toolset = makeToolset({toolFilter: ['spanner_execute_sql']});

      expect(await toolNames(toolset)).toEqual(['spanner_execute_sql']);
    });

    it('drops a name no tool carries', async () => {
      expect(await toolNames(makeToolset({toolFilter: ['unknown']}))).toEqual(
        [],
      );
    });

    it('keeps the known names beside an unknown one', async () => {
      const toolset = makeToolset({
        toolFilter: ['unknown', 'spanner_execute_sql'],
      });

      expect(await toolNames(toolset)).toEqual(['spanner_execute_sql']);
    });

    it('does not match the unprefixed adk-python name', async () => {
      expect(
        await toolNames(makeToolset({toolFilter: ['execute_sql']})),
      ).toEqual([]);
    });

    it('withholds a gated tool the filter names', async () => {
      const toolset = makeToolset({
        settings: {capabilities: []},
        toolFilter: ['spanner_execute_sql', 'spanner_list_table_names'],
      });

      expect(await toolNames(toolset)).toEqual(['spanner_list_table_names']);
    });

    it('applies a name filter with a context too', async () => {
      const toolset = makeToolset({toolFilter: ['spanner_list_named_schemas']});

      expect(await toolNames(toolset, makeToolContext())).toEqual([
        'spanner_list_named_schemas',
      ]);
    });

    it('applies a predicate when there is a context', async () => {
      const predicate = (tool: BaseTool) => tool.name.endsWith('_sql');
      const toolset = makeToolset({toolFilter: predicate});

      expect(await toolNames(toolset, makeToolContext())).toEqual([
        'spanner_execute_sql',
      ]);
    });

    it('applies nothing when a predicate has no context', async () => {
      // A predicate cannot run without a context, so every tool is returned,
      // as `OpenAPIToolset` does in the same situation.
      const toolset = makeToolset({toolFilter: () => false});

      expect(await toolNames(toolset)).toHaveLength(7);
    });
  });

  it('closes without complaint, twice', async () => {
    const toolset = makeToolset();

    await expect(toolset.close()).resolves.toBeUndefined();
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
