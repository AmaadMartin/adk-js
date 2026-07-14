/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Options for `SaveFilesAsArtifactsPlugin`.
 */
export interface SaveFilesAsArtifactsPluginOptions {
  /**
   * Whether to attach a file reference (FileData) to the user message.
   * Defaults to true.
   */
  attachFileReference?: boolean;
}

/**
 * A plugin that saves files embedded in user messages as artifacts.
 *
 * This is useful to allow users to upload files in the chat experience and have
 * those files available to the agent within the current session.
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  private readonly attachFileReference: boolean;

  constructor(
    options: SaveFilesAsArtifactsPluginOptions & {name?: string} = {},
  ) {
    super(options.name ?? 'save_files_as_artifacts_plugin');
    this.attachFileReference = options.attachFileReference !== false;
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    if (!invocationContext.artifactService) {
      logger.warn(
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be enabled.',
      );
      return userMessage;
    }

    if (!userMessage.parts || userMessage.parts.length === 0) {
      return undefined;
    }

    const newParts: Part[] = [];
    const pendingDelta: Record<string, number> = {};
    let modified = false;

    for (let i = 0; i < userMessage.parts.length; i++) {
      const part = userMessage.parts[i];
      if (!part.inlineData) {
        newParts.push(part);
        continue;
      }

      try {
        const inlineData = part.inlineData;
        let fileName = inlineData.displayName;
        if (!fileName) {
          fileName = `artifact_${invocationContext.invocationId}_${i}`;
          logger.info(
            `No displayName found, using generated filename: ${fileName}`,
          );
        }

        const version = await invocationContext.artifactService.saveArtifact({
          filename: fileName,
          artifact: part,
        });

        const placeholderPart: Part = {
          text: `[Uploaded Artifact: "${fileName}"]`,
        };
        newParts.push(placeholderPart);

        if (this.attachFileReference) {
          const filePart = await this.buildFileReferencePart({
            invocationContext,
            filename: fileName,
            version,
            mimeType: inlineData.mimeType,
          });
          if (filePart) {
            newParts.push(filePart);
          }
        }
        pendingDelta[fileName] = version;
        modified = true;
        logger.info(`Successfully saved artifact: ${fileName}`);
      } catch (e) {
        logger.error(`Failed to save artifact for part ${i}: ${e}`);
        newParts.push(part);
        continue;
      }
    }

    if (!modified) {
      return undefined;
    }

    const stateKey = `${this.name}:pending_delta`;
    const existingDelta =
      (invocationContext.session.state[stateKey] as Record<string, number>) ||
      {};
    invocationContext.session.state[stateKey] = {
      ...existingDelta,
      ...pendingDelta,
    };
    return {
      role: userMessage.role,
      parts: newParts,
    };
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const stateKey = `${this.name}:pending_delta`;
    const pendingDelta =
      callbackContext.state.get<Record<string, number>>(stateKey);
    if (pendingDelta) {
      Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
      callbackContext.state.set(stateKey, {});
    }
    return undefined;
  }

  private async buildFileReferencePart({
    invocationContext,
    filename,
    version,
    mimeType,
  }: {
    invocationContext: InvocationContext;
    filename: string;
    version: number;
    mimeType?: string;
  }): Promise<Part | undefined> {
    const artifactService = invocationContext.artifactService!;

    try {
      const artifactVersion = await artifactService.getArtifactVersion({
        filename,
        version,
      });

      if (
        !artifactVersion ||
        !artifactVersion.canonicalUri ||
        !/^(gs|https?):/i.test(artifactVersion.canonicalUri)
      ) {
        return undefined;
      }

      return {
        fileData: {
          fileUri: artifactVersion.canonicalUri,
          mimeType: mimeType || artifactVersion.mimeType,
          displayName: filename,
        },
      };
    } catch (exc) {
      logger.warn(`Failed to resolve artifact version for ${filename}: ${exc}`);
      return undefined;
    }
  }
}
