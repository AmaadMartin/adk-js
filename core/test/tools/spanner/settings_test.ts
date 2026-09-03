/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SpannerVectorStoreSettings,
  resolveVectorStoreSettings,
} from '@google/adk/tools/spanner';
import {describe, expect, it} from 'vitest';

function vectorStore(
  overrides: Partial<SpannerVectorStoreSettings> = {},
): SpannerVectorStoreSettings {
  return {
    projectId: 'p',
    instanceId: 'i',
    databaseId: 'd',
    tableName: 'documents',
    contentColumn: 'content',
    embeddingColumn: 'embedding',
    vectorLength: 768,
    vertexAiEmbeddingModelName: 'text-embedding-005',
    ...overrides,
  };
}

describe('resolveVectorStoreSettings', () => {
  it('returns the content column when no columns are selected', () => {
    expect(resolveVectorStoreSettings(vectorStore()).selectedColumns).toEqual([
      'content',
    ]);
  });

  it('returns the content column when the selection is empty', () => {
    const settings = vectorStore({selectedColumns: []});

    expect(resolveVectorStoreSettings(settings).selectedColumns).toEqual([
      'content',
    ]);
  });

  it('keeps a selection the developer made', () => {
    const settings = vectorStore({selectedColumns: ['title', 'body']});

    expect(resolveVectorStoreSettings(settings).selectedColumns).toEqual([
      'title',
      'body',
    ]);
  });

  it('leaves the other fields untouched', () => {
    const settings = vectorStore({topK: 9, distanceType: 'EUCLIDEAN'});

    expect(resolveVectorStoreSettings(settings)).toMatchObject({
      topK: 9,
      distanceType: 'EUCLIDEAN',
      tableName: 'documents',
    });
  });

  it.each([0, -1])('rejects a vector length of %i', (vectorLength) => {
    expect(() =>
      resolveVectorStoreSettings(vectorStore({vectorLength})),
    ).toThrow('Invalid vector length in the Spanner vector store settings.');
  });

  it('accepts a primary key naming the content or embedding column', () => {
    const settings = vectorStore({primaryKeyColumns: ['content', 'embedding']});

    expect(() => resolveVectorStoreSettings(settings)).not.toThrow();
  });

  it('accepts a primary key naming an extra column it also sets up', () => {
    const settings = vectorStore({
      additionalColumnsToSetup: [{name: 'doc_id', type: 'STRING(MAX)'}],
      primaryKeyColumns: ['doc_id'],
    });

    expect(() => resolveVectorStoreSettings(settings)).not.toThrow();
  });

  it('rejects a primary key that names no defined column', () => {
    const settings = vectorStore({primaryKeyColumns: ['content', 'missing']});

    expect(() => resolveVectorStoreSettings(settings)).toThrow(
      "Primary key column 'missing' not found in column definitions.",
    );
  });
});
