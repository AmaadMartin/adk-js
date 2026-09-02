/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseRetrievalTool} from '../base_retrieval_tool.js';
import {RunAsyncToolRequest} from '../base_tool.js';

/**
 * The metadata mode that makes a node return its raw text.
 *
 * LlamaIndex.TS spells this `MetadataMode.NONE`, whose value is the string
 * `'NONE'`. The literal is inlined so that ADK does not import `llamaindex`.
 */
const METADATA_MODE_NONE = 'NONE';

/**
 * A retrieved chunk of text.
 *
 * A LlamaIndex.TS `BaseNode` satisfies this structurally, because it declares
 * `getContent(metadataMode: MetadataMode): string`.
 */
export interface LlamaIndexNode {
  getContent(metadataMode: string): string;
}

/**
 * The part of a LlamaIndex.TS `BaseRetriever` that this tool calls.
 *
 * The tool depends on this structural type instead of the `llamaindex`
 * package, so ADK never takes on that dependency.
 */
export interface LlamaIndexRetriever {
  /**
   * Returns the hits for `query`, best first. A LlamaIndex.TS `NodeWithScore`
   * satisfies the element type; its `score` is not declared, because this tool
   * trusts the retriever's own ranking.
   */
  retrieve(query: string): Promise<Array<{node: LlamaIndexNode}>>;
}

/** Parameters for the `LlamaIndexRetrievalTool` constructor. */
export interface LlamaIndexRetrievalToolParams {
  name: string;
  description: string;
  retriever: LlamaIndexRetriever;
}

/**
 * A tool that answers a query from a LlamaIndex.TS index.
 *
 * Give it a retriever you already built, and the model can ground its answers
 * in that index. The tool returns the text of the top-ranked hit only.
 *
 * A query that matches nothing is a normal outcome, so the tool returns a
 * message that says so instead of throwing. The model can then continue the
 * turn.
 *
 * @example
 * ```ts
 * const tool = new LlamaIndexRetrievalTool({
 *   name: 'docs',
 *   description: 'Retrieves documentation.',
 *   retriever: index.asRetriever(),
 * });
 * ```
 */
export class LlamaIndexRetrievalTool extends BaseRetrievalTool {
  private readonly retriever: LlamaIndexRetriever;

  constructor({name, description, retriever}: LlamaIndexRetrievalToolParams) {
    super({name, description});
    this.retriever = retriever;
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<string> {
    const query = args['query'];
    if (typeof query !== 'string') {
      throw new Error(`Tool ${this.name} requires a string 'query' argument.`);
    }

    const results = await this.retriever.retrieve(query);
    if (results.length === 0) {
      return `No matching result found for the query: ${query}`;
    }
    return results[0].node.getContent(METADATA_MODE_NONE);
  }
}
