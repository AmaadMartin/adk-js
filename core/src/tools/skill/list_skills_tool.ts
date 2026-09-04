/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {formatSkillsAsXml} from '../../skills/prompt.js';
import {experimental} from '../../utils/experimental.js';
import {RunAsyncToolRequest} from '../base_tool.js';
import {SkillTool} from './skill_tool.js';
import {LIST_SKILLS_TOOL_NAME} from './skill_tool_names.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class ListSkillsTool extends SkillTool {
  static readonly TOOL_NAME = LIST_SKILLS_TOOL_NAME;

  constructor(toolset: SkillToolset) {
    super(toolset, {
      name: toolset.toolName(ListSkillsTool.TOOL_NAME),
      description:
        'Lists all available skills with their names and descriptions.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    };
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    const skills = Object.values(this.toolset.skills);
    return formatSkillsAsXml(skills);
  }
}
