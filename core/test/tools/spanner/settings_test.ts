/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROXIMATE_NEAREST_NEIGHBORS,
  Capabilities,
  EXACT_NEAREST_NEIGHBORS,
  QueryResultMode,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const vectorStoreRequired = {
  projectId: 'p',
  instanceId: 'i',
  databaseId: 'd',
  tableName: 'documents',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
};

describe('Spanner enum values', () => {
  it('keeps the wire values adk-python uses', () => {
    expect(Capabilities.DATA_READ).toBe('data_read');
    expect(QueryResultMode.DEFAULT).toBe('default');
    expect(QueryResultMode.DICT_LIST).toBe('dict_list');
    expect(EXACT_NEAREST_NEIGHBORS).toBe('EXACT_NEAREST_NEIGHBORS');
    expect(APPROXIMATE_NEAREST_NEIGHBORS).toBe('APPROXIMATE_NEAREST_NEIGHBORS');
  });
});

describe('SpannerVectorStoreSettings', () => {
  it('applies the adk-python defaults', () => {
    const settings = new SpannerVectorStoreSettings(vectorStoreRequired);
    expect(settings.selectedColumns).toEqual(['content']);
    expect(settings.nearestNeighborsAlgorithm).toBe(EXACT_NEAREST_NEIGHBORS);
    expect(settings.topK).toBe(4);
    expect(settings.distanceType).toBe('COSINE');
    expect(settings.numLeavesToSearch).toBeUndefined();
    expect(settings.additionalFilter).toBeUndefined();
  });

  it('keeps the columns the caller selected', () => {
    const settings = new SpannerVectorStoreSettings({
      ...vectorStoreRequired,
      selectedColumns: ['title', 'content'],
    });
    expect(settings.selectedColumns).toEqual(['title', 'content']);
  });

  it('defaults the selected columns when the list is empty', () => {
    const settings = new SpannerVectorStoreSettings({
      ...vectorStoreRequired,
      selectedColumns: [],
    });
    expect(settings.selectedColumns).toEqual(['content']);
  });

  it.each([0, -1])('rejects a vector length of %i', (vectorLength) => {
    expect(
      () =>
        new SpannerVectorStoreSettings({...vectorStoreRequired, vectorLength}),
    ).toThrow('Invalid vector length in the Spanner vector store settings.');
  });
});

describe('SpannerToolSettings', () => {
  it('is constructible with no arguments and yields the defaults', () => {
    const settings = new SpannerToolSettings();
    expect(settings.capabilities).toEqual([Capabilities.DATA_READ]);
    expect(settings.maxExecutedQueryResultRows).toBe(50);
    expect(settings.queryResultMode).toBe(QueryResultMode.DEFAULT);
    expect(settings.databaseRole).toBeUndefined();
    expect(settings.vectorStoreSettings).toBeUndefined();
  });

  it('keeps every option the caller supplied', () => {
    const vectorStoreSettings = new SpannerVectorStoreSettings(
      vectorStoreRequired,
    );
    const settings = new SpannerToolSettings({
      capabilities: [],
      maxExecutedQueryResultRows: 5,
      queryResultMode: QueryResultMode.DICT_LIST,
      databaseRole: 'reader',
      vectorStoreSettings,
    });
    expect(settings.capabilities).toEqual([]);
    expect(settings.maxExecutedQueryResultRows).toBe(5);
    expect(settings.queryResultMode).toBe(QueryResultMode.DICT_LIST);
    expect(settings.databaseRole).toBe('reader');
    expect(settings.vectorStoreSettings).toBe(vectorStoreSettings);
  });
});
