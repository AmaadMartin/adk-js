/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import {appendInstructions, LlmRequest} from '../models/llm_request.js';
import {getLogger} from '../utils/logger.js';
import {asSafePartForLlm} from '../utils/part_utils.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

const logger = getLogger();

/**
 * A tool that loads the artifacts and adds them to the session.
 */
export class LoadArtifactsTool extends BaseTool {
  constructor() {
    super({
      name: 'load_artifacts',
      description: `Loads artifacts into the session for this request.\n\nNOTE: Call when you need access to artifacts (for example, uploads saved by the web UI).`,
    });
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          artifact_names: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
            description: 'The names of the artifacts to load.',
          },
        },
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const artifactNames = (args['artifact_names'] as string[]) || [];
    return {
      artifact_names: artifactNames,
      status:
        'artifact contents temporarily inserted and removed. to access these artifacts, call load_artifacts tool again.',
    };
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    await this.appendArtifactsToLlmRequest(
      request.toolContext,
      request.llmRequest,
    );
  }

  private async appendArtifactsToLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    if (!toolContext.invocationContext.artifactService) {
      return;
    }

    const artifactNames = await toolContext.listArtifacts();
    if (!artifactNames || artifactNames.length === 0) {
      return;
    }

    appendInstructions(llmRequest, [
      `You have a list of artifacts:\n  ${JSON.stringify(
        artifactNames,
      )}\n\n  When the user asks questions about any of the artifacts, you should call the\n  \`load_artifacts\` function to load the artifact. Always call load_artifacts\n  before answering questions related to the artifacts, regardless of whether the\n  artifacts have been loaded before. Do not depend on prior answers about the\n  artifacts.`,
    ]);

    const contents = llmRequest.contents;
    if (!contents || contents.length === 0) {
      return;
    }

    // Find the start index of the current turn.
    // A turn begins after the last completed model response (model message with text)
    // or at the latest user message that is not a tool response (user prompt).
    let startIndex = 0;
    for (let i = contents.length - 1; i >= 0; i--) {
      const content = contents[i];
      const hasFunctionResponse = content.parts?.some(
        (part) => part.functionResponse !== undefined,
      );
      const hasFunctionCall = content.parts?.some(
        (part) => part.functionCall !== undefined,
      );

      if (
        (content.role === 'model' && !hasFunctionCall) ||
        (content.role === 'user' && !hasFunctionResponse)
      ) {
        startIndex = i;
        break;
      }
    }

    const namesToLoad: string[] = [];
    for (let i = startIndex; i < contents.length; i++) {
      const content = contents[i];
      if (content.role === 'user' && content.parts) {
        for (const part of content.parts) {
          const functionResponse = part.functionResponse;
          if (functionResponse && functionResponse.name === this.name) {
            const response =
              (functionResponse.response as Record<string, unknown>) || {};
            const artifactNames =
              (response['artifact_names'] as string[]) || [];
            for (const name of artifactNames) {
              if (name && !namesToLoad.includes(name)) {
                namesToLoad.push(name);
              }
            }
          }
        }
      }
    }

    for (const artifactName of namesToLoad) {
      let artifact = await toolContext.loadArtifact(artifactName);

      if (!artifact && !artifactName.startsWith('user:')) {
        const prefixedName = `user:${artifactName}`;
        artifact = await toolContext.loadArtifact(prefixedName);
      }

      if (!artifact) {
        logger.warn(`Artifact "${artifactName}" not found, skipping`);
        continue;
      }

      const artifactPart = asSafePartForLlm(artifact, artifactName);

      llmRequest.contents.push({
        role: 'user',
        parts: [{text: `Artifact ${artifactName} is:`}, artifactPart],
      });
    }
  }
}

/**
 * A global instance of {@link LoadArtifactsTool}.
 */
export const LOAD_ARTIFACTS = new LoadArtifactsTool();
