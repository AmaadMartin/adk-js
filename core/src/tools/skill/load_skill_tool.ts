/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {injectSessionState} from '../../agents/instructions.js';
import {requireAgent} from '../../agents/invocation_context.js';
import {experimental} from '../../utils/experimental.js';
import {RunAsyncToolRequest} from '../base_tool.js';
import {SkillErrorCode} from './skill_error_codes.js';
import {detectSkillToolError} from './skill_error_detection.js';
import {SkillTool} from './skill_tool.js';
import {LOAD_SKILL_TOOL_NAME} from './skill_tool_names.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class LoadSkillTool extends SkillTool {
  static readonly TOOL_NAME = LOAD_SKILL_TOOL_NAME;

  constructor(toolset: SkillToolset) {
    super(toolset, {
      name: toolset.toolName(LoadSkillTool.TOOL_NAME),
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
        error_code: SkillErrorCode.MISSING_SKILL_NAME,
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
        error_code: SkillErrorCode.REGISTRY_ERROR,
      };
    }

    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: SkillErrorCode.SKILL_NOT_FOUND,
      };
    }

    // Record skill activation in agent state
    const agentName = requireAgent(toolContext.invocationContext).name;
    const stateKey = `_adk_activated_skill_${agentName}`;

    const currentActivated = toolContext.state.get<string[]>(stateKey) || [];
    if (!currentActivated.includes(skillName)) {
      toolContext.state.set(stateKey, [...currentActivated, skillName]);
    }

    // A skill opts in to templating so an instruction that legitimately
    // contains braces is not rewritten behind its author's back.
    const instructions = skill.frontmatter.metadata?.['adk_inject_state']
      ? await injectSessionState(skill.instructions, toolContext)
      : skill.instructions;

    return {
      skill_name: skillName,
      instructions,
      frontmatter: skill.frontmatter,
      resources: skill.resources,
    };
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    return detectSkillToolError(response);
  }
}
