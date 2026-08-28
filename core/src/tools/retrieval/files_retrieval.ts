/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';

import {loadTextChunks} from './document_loader.js';
import {EmbeddingModel, GeminiEmbeddingModel} from './embedding_model.js';
import {IndexedChunk, InMemoryVectorRetriever} from './in_memory_retriever.js';
import {RetrieverTool, RetrieverToolParams} from './retriever_tool.js';

/** Options for `FilesRetrieval.create`. */
export interface FilesRetrievalOptions {
  name: string;
  description: string;
  /** Directory whose files are indexed. */
  inputDir: string;
  /** Defaults to a `GeminiEmbeddingModel` with the Gemini defaults. */
  embeddingModel?: EmbeddingModel;
}

/**
 * Answers queries from the text files in a local directory.
 *
 * The directory is read and embedded once, when the tool is created. Later
 * calls only embed the query, so they touch neither the filesystem nor the
 * document index.
 */
export class FilesRetrieval extends RetrieverTool {
  readonly inputDir: string;

  /** Use `FilesRetrieval.create`: a constructor cannot await the index build. */
  private constructor(params: RetrieverToolParams & {inputDir: string}) {
    super(params);
    this.inputDir = params.inputDir;
  }

  /**
   * Indexes every readable UTF-8 text file under `inputDir`.
   *
   * @param options The tool name, description, directory and embedding model.
   * @return A tool that can go straight into `new LlmAgent({tools: [...]})`.
   * @throws If the directory is missing, or holds no text to index.
   */
  static async create(options: FilesRetrievalOptions): Promise<FilesRetrieval> {
    const embeddingModel = options.embeddingModel ?? new GeminiEmbeddingModel();

    logger.debug(`Loading data from ${options.inputDir}`);
    const chunks = await loadTextChunks(options.inputDir);
    if (chunks.length === 0) {
      throw new Error(`No files found in: ${options.inputDir}`);
    }

    const embeddings = await embeddingModel.embedDocuments(chunks);
    const indexed: IndexedChunk[] = chunks.map((text, index) => ({
      text,
      embedding: embeddings[index],
    }));

    return new FilesRetrieval({
      name: options.name,
      description: options.description,
      inputDir: options.inputDir,
      retriever: new InMemoryVectorRetriever(indexed, embeddingModel),
    });
  }
}
