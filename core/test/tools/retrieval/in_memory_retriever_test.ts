/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EmbeddingModel,
  IndexedChunk,
  InMemoryVectorRetriever,
} from '@google/adk';
import {cosineSimilarity} from '@google/adk/tools/retrieval/in_memory_retriever.js';
import {describe, expect, it} from 'vitest';

/** Embeds a query to the vector the test hands it, with no API call. */
class FixedEmbeddingModel implements EmbeddingModel {
  constructor(private readonly queryEmbedding: number[]) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => this.queryEmbedding);
  }

  async embedQuery(_text: string): Promise<number[]> {
    return this.queryEmbedding;
  }
}

const CHUNKS: IndexedChunk[] = [
  {text: 'orthogonal', embedding: [0, 1, 0]},
  {text: 'exact', embedding: [1, 0, 0]},
  {text: 'close', embedding: [1, 1, 0]},
];

describe('cosineSimilarity', () => {
  it('scores identical vectors 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('scores orthogonal vectors 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('scores opposite vectors -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it.each([
    ['the first', [0, 0], [1, 2]],
    ['the second', [1, 2], [0, 0]],
  ])('returns 0 when %s vector has no magnitude', (_name, a, b) => {
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('InMemoryVectorRetriever', () => {
  it('returns the chunks nearest the query first', async () => {
    const retriever = new InMemoryVectorRetriever(
      CHUNKS,
      new FixedEmbeddingModel([1, 0, 0]),
      3,
    );

    const documents = await retriever.retrieve('anything');

    expect(documents.map((document) => document.text)).toEqual([
      'exact',
      'close',
      'orthogonal',
    ]);
    expect(documents[0].score).toBeCloseTo(1);
  });

  it('returns at most similarityTopK chunks', async () => {
    const retriever = new InMemoryVectorRetriever(
      CHUNKS,
      new FixedEmbeddingModel([1, 0, 0]),
      2,
    );

    const documents = await retriever.retrieve('anything');

    expect(documents.map((document) => document.text)).toEqual([
      'exact',
      'close',
    ]);
  });

  it('keeps two chunks by default, as llama-index does', async () => {
    const retriever = new InMemoryVectorRetriever(
      CHUNKS,
      new FixedEmbeddingModel([1, 0, 0]),
    );

    expect(await retriever.retrieve('anything')).toHaveLength(2);
  });

  it('returns nothing for an empty index, without embedding the query', async () => {
    const embeddingModel = new FixedEmbeddingModel([1, 0, 0]);
    const retriever = new InMemoryVectorRetriever([], embeddingModel);

    expect(await retriever.retrieve('anything')).toEqual([]);
  });
});
