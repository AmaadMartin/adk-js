/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {VertexRagStore} from '@google/genai';

import {
  isGeminiModel,
  isGeminiModelIdCheckDisabled,
} from '../utils/model_name.js';

import {BaseRetrievalTool} from './base_retrieval_tool.js';
import {RunAsyncToolRequest, ToolProcessLlmRequest} from './base_tool.js';
import {retrieveRagContexts} from './vertex_rag_retrieval_client.js';

const DEFAULT_TOOL_NAME = 'vertex_rag_retrieval';
const DEFAULT_TOOL_DESCRIPTION = 'Vertex AI RAG Retrieval Tool';

/** Configuration for {@link VertexRagRetrievalTool}. */
export interface VertexRagRetrievalToolParams extends VertexRagStore {
  /** Tool name a model sees when it calls the tool as a function. */
  name?: string;
  /** Tool description a model sees when it calls the tool as a function. */
  description?: string;
}

/**
 * A tool that retrieves relevant content from a Vertex AI RAG corpus to ground
 * model responses.
 *
 * The tool runs in one of two modes, chosen by the model on the request:
 *
 * - A Gemini model retrieves server-side. The tool adds
 *   `retrieval.vertexRagStore` to the request config, and the model never sees
 *   a function to call.
 * - Another model cannot honour that built-in tool, so the tool declares the
 *   inherited `query` function instead and performs the retrieval itself when
 *   the model calls it.
 *
 * `ADK_DISABLE_GEMINI_MODEL_ID_CHECK` forces the server-side mode, for a model
 * that Gemini serves under an id the check does not recognise.
 *
 * **Note:** The Vertex AI RAG Engine only supports one corpus per
 * `ragResources` array. Create one `VertexRagRetrievalTool` instance per
 * corpus.
 *
 * @example
 * ```ts
 * import { VertexRagRetrievalTool } from '@google/adk';
 *
 * const ragTool = new VertexRagRetrievalTool({
 *   name: 'rag_retrieval',
 *   description: 'Retrieves product documentation.',
 *   ragResources: [{ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/my-corpus'}],
 *   similarityTopK: 5,
 * });
 *
 * const agent = new LlmAgent({ tools: [ragTool], ... });
 * ```
 */
export class VertexRagRetrievalTool extends BaseRetrievalTool {
  private readonly vertexRagStore: VertexRagStore;

  constructor(params: VertexRagRetrievalToolParams) {
    const {
      name = DEFAULT_TOOL_NAME,
      description = DEFAULT_TOOL_DESCRIPTION,
      ...vertexRagStore
    } = params;
    super({name, description});
    this.vertexRagStore = vertexRagStore;
  }

  /**
   * Retrieves the contexts that match the model-supplied query.
   *
   * Matching nothing is a normal outcome, so the tool answers with a message
   * that says so rather than throwing.
   *
   * @return The text of every matching context, or the no-match message.
   * @throws Error when the model supplies no string `query`.
   */
  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const query = args['query'];
    if (typeof query !== 'string') {
      throw new Error("Vertex AI RAG retrieval requires a string 'query'.");
    }

    const contexts = await retrieveRagContexts({
      query,
      vertexRagStore: this.vertexRagStore,
    });
    if (contexts.length === 0) {
      return `No matching result found with the config: ${JSON.stringify(this.vertexRagStore)}`;
    }
    return contexts.map((context) => context.text);
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    const {llmRequest} = request;
    if (!supportsBuiltInRetrieval(llmRequest.model)) {
      return super.processLlmRequest(request);
    }

    llmRequest.config = llmRequest.config || {};
    llmRequest.config.tools = llmRequest.config.tools || [];
    llmRequest.config.tools.push({
      retrieval: {vertexRagStore: this.vertexRagStore},
    });

    // The server-side branch sends no declaration, so `BaseTool` never
    // registers the name and a model that returns the tool as an explicit
    // function call could not be routed. Claim the name here, as `BuiltInTool`
    // does for the tools that only ever run inside the model. `runAsync`
    // answers such a call with a real retrieval.
    // `Object.hasOwn` rather than `in`, so a tool named after an
    // `Object.prototype` member is not read as already registered.
    if (!Object.hasOwn(llmRequest.toolsDict, this.name)) {
      llmRequest.toolsDict[this.name] = this;
    }
  }
}

/** Whether the model serves Vertex AI RAG retrieval as a built-in tool. */
function supportsBuiltInRetrieval(model: string | undefined): boolean {
  return (!!model && isGeminiModel(model)) || isGeminiModelIdCheckDisabled();
}
