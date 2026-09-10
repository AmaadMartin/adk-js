/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {VertexAiMemoryBankService} from '../memory/vertex_ai_memory_bank_service.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * A tool that loads the current user's structured profiles from Vertex Memory
 * Bank.
 *
 * Profiles are a Memory Bank capability distinct from memory search: a
 * scope-keyed lookup of schema-shaped records, not a semantic query. Give the
 * model this tool when it should fetch the user's profile record on demand,
 * instead of the developer placing that record in the system instruction on
 * every turn.
 *
 * The tool takes no arguments. It reads the app name and the user id from the
 * tool context, so the model cannot ask for another user's profiles.
 *
 * @example
 * ```ts
 * const memoryService = new VertexAiMemoryBankService({agentEngineId: '456'});
 * const agent = new LlmAgent({
 *   name: 'concierge',
 *   model: 'gemini-2.5-flash',
 *   tools: [new VertexAiLoadProfilesTool(memoryService)],
 * });
 * ```
 */
export class VertexAiLoadProfilesTool extends BaseTool {
  constructor(private readonly memoryService: VertexAiMemoryBankService) {
    super({
      name: 'load_profiles',
      description: 'Loads structured user profiles for the current user.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {type: Type.OBJECT, properties: {}},
    };
  }

  override async runAsync({toolContext}: RunAsyncToolRequest): Promise<{
    profiles: Array<Record<string, unknown>>;
  }> {
    const profiles = await this.memoryService.retrieveProfiles({
      appName: toolContext.invocationContext.appName,
      userId: toolContext.userId,
    });

    // An empty payload is dropped, matching Python's falsy check on the
    // profile body. `{}` is truthy in JavaScript, so the length test carries
    // that behaviour.
    return {
      profiles: profiles.flatMap((entry) =>
        entry.profile && Object.keys(entry.profile).length > 0
          ? [entry.profile]
          : [],
      ),
    };
  }
}
