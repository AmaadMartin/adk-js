/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import type {VertexAiMemoryBankService} from '../memory/vertex_ai_memory_bank_service.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * A tool that loads a user's structured profiles from Vertex AI Memory Bank.
 *
 * The profile scope comes from the invocation context, never from the model,
 * so a caller cannot ask for another user's profiles.
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

  override async runAsync({
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const profiles = await this.memoryService.retrieveProfiles({
      appName: toolContext.invocationContext.session.appName,
      userId: toolContext.userId,
    });

    return {
      // adk-python drops a profile when its body is falsy; `{}` is truthy in JS.
      profiles: profiles
        .map((entry) => entry.profile)
        .filter((profile) => profile && Object.keys(profile).length > 0),
    };
  }
}
