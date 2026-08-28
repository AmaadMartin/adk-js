/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EmbedContentParameters,
  EmbedContentResponse,
  GoogleGenAI,
} from '@google/genai';

import {
  getGoogleLlmVariant,
  GoogleLLMVariant,
} from '../../utils/variant_utils.js';

/** The embedding model `getDefaultEmbeddingModel` uses, as in adk-python. */
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2-preview';

/** Texts per `embedContent` call, as in adk-python. */
export const DEFAULT_EMBED_BATCH_SIZE = 1;

const DOCUMENT_TASK_TYPE = 'RETRIEVAL_DOCUMENT';
const QUERY_TASK_TYPE = 'RETRIEVAL_QUERY';

/** Turns text into vectors an index can compare. */
export interface EmbeddingModel {
  /** Embeds documents for indexing. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embeds a search query. */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * The slice of the `@google/genai` client that `GeminiEmbeddingModel` calls.
 *
 * A `GoogleGenAI` instance satisfies it, and so does a test double, which is
 * what keeps the retrieval tools testable without credentials.
 */
export interface EmbedContentClient {
  models: {
    embedContent(params: EmbedContentParameters): Promise<EmbedContentResponse>;
  };
}

/** Options for the `GeminiEmbeddingModel` constructor. */
export interface GeminiEmbeddingModelOptions {
  /** Defaults to `gemini-embedding-2-preview`. */
  model?: string;
  /** Texts per `embedContent` call. Defaults to 1. */
  embedBatchSize?: number;
  /** Client to embed with. Defaults to a client built from the environment. */
  client?: EmbedContentClient;
}

/**
 * Builds the client used when the caller injects none, choosing the backend
 * the environment selects.
 */
export function createDefaultEmbedContentClient(): GoogleGenAI {
  if (getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI) {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env['GOOGLE_CLOUD_PROJECT'],
      location: process.env['GOOGLE_CLOUD_LOCATION'],
    });
  }
  return new GoogleGenAI({apiKey: process.env['GOOGLE_API_KEY']});
}

function toBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}

/** Embeds text with the Gemini embedding API. */
export class GeminiEmbeddingModel implements EmbeddingModel {
  readonly model: string;
  readonly embedBatchSize: number;
  private client?: EmbedContentClient;

  constructor(options: GeminiEmbeddingModelOptions = {}) {
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.embedBatchSize = options.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    this.client = options.client;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const batches = toBatches(texts, this.embedBatchSize);
    const embedded = await Promise.all(
      batches.map((batch) => this.embed(batch, DOCUMENT_TASK_TYPE)),
    );
    return embedded.flat();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text], QUERY_TASK_TYPE);
    return embedding;
  }

  /**
   * The client is built on first use, not in the constructor, so a tool that
   * is never called does not require credentials.
   */
  private getClient(): EmbedContentClient {
    this.client ??= createDefaultEmbedContentClient();
    return this.client;
  }

  private async embed(texts: string[], taskType: string): Promise<number[][]> {
    const response = await this.getClient().models.embedContent({
      model: this.model,
      contents: texts,
      config: {taskType},
    });

    const vectors: number[][] = [];
    for (const embedding of response.embeddings ?? []) {
      if (embedding.values) {
        vectors.push(embedding.values);
      }
    }
    if (vectors.length !== texts.length) {
      throw new Error(
        `Embedding model ${this.model} returned ${vectors.length} embeddings ` +
          `for ${texts.length} inputs.`,
      );
    }
    return vectors;
  }
}

/**
 * The embedding model the retrieval tools use when the caller supplies none.
 *
 * This is a module-level function rather than a static member so that a caller
 * can swap the default without subclassing, which is how adk-python's
 * `_get_default_embedding_model` behaves.
 */
export function getDefaultEmbeddingModel(): GeminiEmbeddingModel {
  return new GeminiEmbeddingModel();
}
