/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {requireAgent} from '../../agents/invocation_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

/**
 * Error codes returned by {@link LoadSkillTool} when a call cannot be
 * completed. The string values are part of the tool's response contract and
 * must remain stable.
 */
export enum LoadSkillErrorCode {
  MISSING_SKILL_NAME = 'MISSING_SKILL_NAME',
  REGISTRY_ERROR = 'REGISTRY_ERROR',
  SKILL_NOT_FOUND = 'SKILL_NOT_FOUND',
}

@experimental
export class LoadSkillTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'load_skill',
      description: 'Loads the SKILL.md instructions for a given skill.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description: 'The name of the skill to load.',
          },
        },
        required: ['name'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['name'] as string;
    if (!skillName) {
      return {
        error: 'Skill name is required.',
        error_code: LoadSkillErrorCode.MISSING_SKILL_NAME,
      };
    }

    let skill;
    try {
      skill = await this.toolset.getOrFetchSkill(
        skillName,
        toolContext.invocationId,
      );
    } catch (e: unknown) {
      return {
        error: `Failed to fetch skill '${skillName}' from registry: ${(e as Error).message || e}`,
        error_code: LoadSkillErrorCode.REGISTRY_ERROR,
      };
    }

    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: LoadSkillErrorCode.SKILL_NOT_FOUND,
      };
    }

    // Record skill activation in agent state
    const agentName = requireAgent(toolContext.invocationContext).name;
    const stateKey = `_adk_activated_skill_${agentName}`;

    const currentActivated = toolContext.state.get<string[]>(stateKey) || [];
    if (!currentActivated.includes(skillName)) {
      toolContext.state.set(stateKey, [...currentActivated, skillName]);
    }

    return {
      skill_name: skillName,
      instructions: skill.instructions,
      frontmatter: skill.frontmatter,
      resources: skill.resources,
    };
  }
}
