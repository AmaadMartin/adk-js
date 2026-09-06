/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SpannerVectorStoreSettings} from '@google/adk/tools/spanner';
import {describe, expect, it} from 'vitest';
// Not part of the public entry point: the toolset constructor is its only
// caller, so it is imported from the source it lives in.
import {resolveVectorStoreSettings} from '../../../src/tools/spanner/settings.js';

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
});
