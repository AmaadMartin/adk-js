/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EmbeddingModel} from './embedding_model.js';
import {RetrievedDocument, Retriever} from './retriever_tool.js';

/** Documents a query returns, matching llama-index's `as_retriever` default. */
export const DEFAULT_SIMILARITY_TOP_K = 2;

/** A chunk of text together with the vector that represents it. */
export interface IndexedChunk {
  text: string;
  embedding: number[];
}

/**
 * The cosine of the angle between two vectors, in the range -1 to 1.
 *
 * Both vectors must have the same dimension, which holds because one embedding
 * model produces both. A vector of zero magnitude scores 0 rather than
 * dividing by zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let squaredA = 0;
  let squaredB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    squaredA += a[i] * a[i];
    squaredB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(squaredA) * Math.sqrt(squaredB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Ranks a fixed set of pre-embedded chunks by cosine similarity to the query.
 *
 * The index lives in memory and is never written to disk, so it is rebuilt
 * every time the owning tool is created.
 */
export class InMemoryVectorRetriever implements Retriever {
  constructor(
    private readonly chunks: IndexedChunk[],
    private readonly embeddingModel: EmbeddingModel,
  ) {}

  /**
   * Returns the best `DEFAULT_SIMILARITY_TOP_K` chunks, or `[]` for an empty
   * index.
   */
  async retrieve(query: string): Promise<RetrievedDocument[]> {
    if (this.chunks.length === 0) {
      return [];
    }

    const queryEmbedding = await this.embeddingModel.embedQuery(query);
    return this.chunks
      .map((chunk) => ({
        text: chunk.text,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, DEFAULT_SIMILARITY_TOP_K);
  }
}
