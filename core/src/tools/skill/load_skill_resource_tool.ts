/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import path from 'node:path';
import {State} from '../../sessions/state.js';
import {experimental} from '../../utils/experimental.js';
import {guessMimeType} from '../../utils/file_utils.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

/**
 * Error codes returned by {@link LoadSkillResourceTool} when a call cannot be
 * completed. The string values are part of the tool's response contract and
 * must remain stable.
 */
export enum LoadSkillResourceErrorCode {
  MISSING_SKILL_NAME = 'MISSING_SKILL_NAME',
  MISSING_RESOURCE_PATH = 'MISSING_RESOURCE_PATH',
  REGISTRY_ERROR = 'REGISTRY_ERROR',
  SKILL_NOT_FOUND = 'SKILL_NOT_FOUND',
  INVALID_RESOURCE_PATH = 'INVALID_RESOURCE_PATH',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_NOT_FOUND_FATAL = 'RESOURCE_NOT_FOUND_FATAL',
}

/**
 * Prefix of the invocation-scoped resource-lookup failure counter. The
 * {@link State.TEMP_PREFIX} keeps the counter out of durable session storage;
 * the invocation id suffix stops in-memory session backends from carrying a
 * count into the next invocation.
 */
const RESOURCE_NOT_FOUND_COUNT_KEY_PREFIX = `${State.TEMP_PREFIX}_adk_skill_resource_not_found_count_`;

const BINARY_FILE_DETECTED_MSG =
  'Binary file detected. The content has been injected into the conversation history for you to analyze.';

@experimental
export class LoadSkillResourceTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'load_skill_resource',
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
        error_code: LoadSkillResourceErrorCode.MISSING_SKILL_NAME,
      };
    }
    if (!resourcePath) {
      return {
        error: 'Resource path is required.',
        error_code: LoadSkillResourceErrorCode.MISSING_RESOURCE_PATH,
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
        error_code: LoadSkillResourceErrorCode.REGISTRY_ERROR,
      };
    }

    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: LoadSkillResourceErrorCode.SKILL_NOT_FOUND,
      };
    }

    let content: string | Buffer | undefined;
    const skillResources = skill.resources || {};

    if (resourcePath.startsWith('references/')) {
      const refName = resourcePath.substring('references/'.length);
      content = skillResources.references?.[refName];
    } else if (resourcePath.startsWith('assets/')) {
      const assetName = resourcePath.substring('assets/'.length);
      content = skillResources.assets?.[assetName];
    } else if (resourcePath.startsWith('scripts/')) {
      const scriptName = resourcePath.substring('scripts/'.length);
      const script = skillResources.scripts?.[scriptName];
      if (script) {
        content = script.src;
      }
    } else {
      return {
        error: "Path must start with 'references/', 'assets/', or 'scripts/'.",
        error_code: LoadSkillResourceErrorCode.INVALID_RESOURCE_PATH,
      };
    }

    if (content === undefined) {
      // Counted across all paths and skills so the guard still fires when the
      // model hallucinates a different resource path on each retry.
      const counterKey = `${RESOURCE_NOT_FOUND_COUNT_KEY_PREFIX}${toolContext.invocationId}`;
      const failCount = (toolContext.state.get<number>(counterKey) ?? 0) + 1;
      toolContext.state.set(counterKey, failCount);

      const notFoundMessage = `Resource '${resourcePath}' not found in skill '${skillName}'.`;
      if (failCount > 1) {
        return {
          error:
            `${notFoundMessage} This is resource lookup failure #${failCount}` +
            ' this invocation. Do not retry any path — report the error to' +
            ' the user and stop.',
          error_code: LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
        };
      }
      return {
        error: notFoundMessage,
        error_code: LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
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
          const skillResources = skill.resources || {};

          let content: string | Buffer | undefined;
          if (resourcePath.startsWith('references/')) {
            content =
              skillResources.references?.[
                resourcePath.substring('references/'.length)
              ];
          } else if (resourcePath.startsWith('assets/')) {
            content =
              skillResources.assets?.[resourcePath.substring('assets/'.length)];
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
