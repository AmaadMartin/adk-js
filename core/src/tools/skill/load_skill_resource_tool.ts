/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import path from 'node:path';
import {getAsset, getReference, getScript} from '../../skills/skill.js';
import {experimental} from '../../utils/experimental.js';
import {guessMimeType} from '../../utils/file_utils.js';
import {RunAsyncToolRequest, ToolProcessLlmRequest} from '../base_tool.js';
import {SkillErrorCode} from './skill_error_codes.js';
import {detectSkillToolError} from './skill_error_detection.js';
import {
  countInvocationFailure,
  RESOURCE_NOT_FOUND_COUNTER_PREFIX,
} from './skill_failure_counter.js';
import {SkillTool} from './skill_tool.js';
import {LOAD_SKILL_RESOURCE_TOOL_NAME} from './skill_tool_names.js';
import {SkillToolset} from './skill_toolset.js';

const BINARY_FILE_DETECTED_MSG =
  'Binary file detected. The content has been injected into the conversation history for you to analyze.';

@experimental
export class LoadSkillResourceTool extends SkillTool {
  static readonly TOOL_NAME = LOAD_SKILL_RESOURCE_TOOL_NAME;

  constructor(toolset: SkillToolset) {
    super(toolset, {
      name: toolset.toolName(LoadSkillResourceTool.TOOL_NAME),
      description:
        'Loads a resource file (from references/, assets/, or scripts/) from within a skill.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          skill_name: {
            type: Type.STRING,
            description: 'The name of the skill.',
          },
          path: {
            type: Type.STRING,
            description:
              "The relative path to the resource (e.g., 'references/my_doc.md', 'assets/template.txt', or 'scripts/setup.sh').",
          },
        },
        required: ['skill_name', 'path'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['skill_name'] as string;
    let resourcePath = args['path'] as string;

    if (!skillName) {
      return {
        error: 'Skill name is required.',
        error_code: SkillErrorCode.MISSING_SKILL_NAME,
      };
    }
    if (!resourcePath) {
      return {
        error: 'Resource path is required.',
        error_code: SkillErrorCode.MISSING_RESOURCE_PATH,
      };
    }

    resourcePath = path.posix.normalize(resourcePath);

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

    let content: string | Buffer | undefined;

    if (resourcePath.startsWith('references/')) {
      const refName = resourcePath.substring('references/'.length);
      content = getReference(skill.resources, refName);
    } else if (resourcePath.startsWith('assets/')) {
      const assetName = resourcePath.substring('assets/'.length);
      content = getAsset(skill.resources, assetName);
    } else if (resourcePath.startsWith('scripts/')) {
      const scriptName = resourcePath.substring('scripts/'.length);
      const script = getScript(skill.resources, scriptName);
      if (script) {
        content = script.src;
      }
    } else {
      return {
        error: "Path must start with 'references/', 'assets/', or 'scripts/'.",
        error_code: SkillErrorCode.INVALID_RESOURCE_PATH,
      };
    }

    if (content === undefined) {
      // Counts every miss in the invocation, not misses of this path, so the
      // guard still fires when the model invents a fresh path each retry.
      const failCount = countInvocationFailure(
        toolContext,
        RESOURCE_NOT_FOUND_COUNTER_PREFIX,
      );
      if (failCount > 1) {
        return {
          error:
            `Resource '${resourcePath}' not found in skill '${skillName}'.` +
            ` This is resource lookup failure #${failCount} this invocation.` +
            ' Do not retry any path — report the error to the user and stop.',
          error_code: SkillErrorCode.RESOURCE_NOT_FOUND_FATAL,
        };
      }
      return {
        error: `Resource '${resourcePath}' not found in skill '${skillName}'.`,
        error_code: SkillErrorCode.RESOURCE_NOT_FOUND,
      };
    }

    if (Buffer.isBuffer(content)) {
      return {
        skill_name: skillName,
        path: resourcePath,
        status: BINARY_FILE_DETECTED_MSG,
      };
    }

    return {
      skill_name: skillName,
      path: resourcePath,
      content,
    };
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    return detectSkillToolError(response);
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);

    const llmRequest = request.llmRequest;
    if (!llmRequest.contents || llmRequest.contents.length === 0) {
      return;
    }

    const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
    if (lastContent.role !== 'user' || !lastContent.parts) {
      return;
    }

    for (const part of lastContent.parts) {
      if (part.functionResponse && part.functionResponse.name === this.name) {
        const response =
          (part.functionResponse.response as Record<string, unknown>) || {};
        if (response['status'] === BINARY_FILE_DETECTED_MSG) {
          const skillName = response['skill_name'] as string;
          const resourcePath = response['path'] as string;

          let skill;
          try {
            skill = await this.toolset.getOrFetchSkill(
              skillName,
              request.toolContext.invocationId,
            );
          } catch (_e: unknown) {
            continue;
          }
          if (!skill) continue;

          let content: string | Buffer | undefined;
          if (resourcePath.startsWith('references/')) {
            content = getReference(
              skill.resources,
              resourcePath.substring('references/'.length),
            );
          } else if (resourcePath.startsWith('assets/')) {
            content = getAsset(
              skill.resources,
              resourcePath.substring('assets/'.length),
            );
          }

          if (Buffer.isBuffer(content)) {
            const mimeType = guessMimeType(resourcePath);
            llmRequest.contents.push({
              role: 'user',
              parts: [
                {text: `The content of binary file '${resourcePath}' is:`},
                {
                  inlineData: {
                    data: content.toString('base64'),
                    mimeType: mimeType,
                  },
                },
              ],
            });
          }
        }
      }
    }
  }
}
