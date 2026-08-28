/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {MemoryEntry} from '../memory/memory_entry.js';
import {appendInstructions} from '../models/llm_request.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

const TOOL_NAME = 'load_memory';

/**
 * Returned to the model when it calls the tool without a usable `query`.
 *
 * The wording matches the missing-argument error that adk-python's
 * `FunctionTool` produces, so both SDKs prompt the model to retry the same way.
 */
const MISSING_QUERY_ERROR = `Invoking \`${TOOL_NAME}()\` failed as the following mandatory input parameters are not present:
query
You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.`;

/**
 * The response of the `load_memory` tool.
 */
export interface LoadMemoryResponse {
  /** The memory entries matching the query. */
  memories: MemoryEntry[];
}

/**
 * A tool that loads the memory for the current user.
 *
 * NOTE: Currently this tool only uses text part from the memory.
 */
export class LoadMemoryTool extends BaseTool {
  constructor() {
    super({
      name: TOOL_NAME,
      description:
        'Loads the memory for the current user.\n\nNOTE: Currently this tool only uses text part from the memory.',
    });
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The query to load the memory for.',
          },
        },
        required: ['query'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<LoadMemoryResponse | {error: string}> {
    const query = args['query'];
    if (typeof query !== 'string') {
      return {error: MISSING_QUERY_ERROR};
    }

    const {memories} = await toolContext.searchMemory(query);
    return {memories};
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);

    appendInstructions(request.llmRequest, [
      `You have memory. You can use it to answer questions. If any questions need\nyou to look up the memory, you should call load_memory function with a query.`,
    ]);
  }
}

/**
 * A global instance of {@link LoadMemoryTool}.
 */
export const LOAD_MEMORY = new LoadMemoryTool();
