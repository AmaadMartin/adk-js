/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import type {SkillToolset} from './skill_toolset.js';

/**
 * Tool to search for relevant skills in the registry.
 */
@experimental
export class SearchSkillsTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    if (!toolset.registry) {
      throw new Error('SearchSkillsTool requires a configured skill registry.');
    }
    const description =
      toolset.registry.searchToolDescription() ||
      'Searches for relevant skills in the registry based on a semantic or keyword query.';
    super({
      name: 'search_skills',
      description,
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'Semantic or keyword search query.',
          },
        },
        required: ['query'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const query = args['query'] as string;
    if (!query) {
      return {
        error: "Argument 'query' is required.",
        error_code: 'INVALID_ARGUMENTS',
      };
    }
    if (!this.toolset.registry) {
      return {
        error: 'SearchSkillsTool requires a configured skill registry.',
        error_code: 'REGISTRY_ERROR',
      };
    }
    try {
      const results = await this.toolset.registry.searchSkills({query});
      const formattedResults = [];
      for (const r of results) {
        if (r.name && r.name in this.toolset.skills) {
          continue;
        }
        formattedResults.push(r);
      }
      return formattedResults;
    } catch (e) {
      return {
        error: `Failed to search skills from registry: ${e}`,
        error_code: 'REGISTRY_ERROR',
      };
    }
  }
}
