/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseRetrievalTool} from '../base_retrieval_tool.js';
import {RunAsyncToolRequest} from '../base_tool.js';

/** A document a `Retriever` returned. Retrievers rank documents best-first. */
export interface RetrievedDocument {
  text: string;
  /** Relevance score, when the retriever produces one. Higher is better. */
  score?: number;
}

/**
 * Anything that can return documents for a query.
 *
 * The interface is structural on purpose. adk-python accepts any llama-index
 * `BaseRetriever`; here an adapter around a vector store or a search API
 * satisfies the same role in a few lines.
 */
export interface Retriever {
  retrieve(query: string): Promise<RetrievedDocument[]>;
}

/** Parameters for the `RetrieverTool` constructor. */
export interface RetrieverToolParams {
  name: string;
  description: string;
  retriever: Retriever;
}

/**
 * Exposes a `Retriever` to the model as a retrieval tool.
 *
 * The tool answers with the text of the top-ranked document. A query that
 * matches nothing returns a message that says so, because matching nothing is
 * a normal outcome.
 */
export class RetrieverTool extends BaseRetrievalTool {
  private readonly retriever: Retriever;

  constructor({name, description, retriever}: RetrieverToolParams) {
    super({name, description});
    this.retriever = retriever;
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    // `args` comes from the model, so the query is validated before it is used.
    const query = args['query'];
    if (typeof query !== 'string' || query.trim() === '') {
      throw new Error(
        'Retrieval requires a non-empty string "query" argument.',
      );
    }

    const documents = await this.retriever.retrieve(query);
    if (documents.length === 0) {
      return `No matching result found for the query: ${query}`;
    }
    return documents[0].text;
  }
}
