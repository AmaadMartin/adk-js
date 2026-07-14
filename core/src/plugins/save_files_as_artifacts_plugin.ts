/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part, createPartFromText} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Options for configuring {@link SaveFilesAsArtifactsPlugin}.
 */
export interface SaveFilesAsArtifactsPluginOptions {
  /**
   * A unique identifier for the plugin instance.
   * Defaults to 'save_files_as_artifacts_plugin'.
   */
  name?: string;
  /**
   * Whether to attach a file reference (`fileData` part) to the user message
   * when an artifact is saved and has a model-accessible canonical URI.
   * Defaults to `true`.
   */
  attachFileReference?: boolean;
}

function isModelAccessibleUri(uri: string): boolean {
  try {
    return ['gs:', 'https:', 'http:'].includes(new URL(uri).protocol);
  } catch {
    return false;
  }
}

/**
 * A plugin that saves inline data blobs embedded in user messages to the
 * session artifact service and replaces them with text placeholders and optional
 * file URI references.
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  readonly attachFileReference: boolean;

  constructor(options?: SaveFilesAsArtifactsPluginOptions) {
    super(options?.name || 'save_files_as_artifacts_plugin');
    this.attachFileReference = options?.attachFileReference ?? true;
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
        `Artifact service is not set. ${this.name} will not be enabled.`,
      );
      return undefined;
    }

    if (!userMessage.parts?.length) {
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
        let fileName =
          inlineData.displayName ||
          (inlineData as {display_name?: string}).display_name;
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

        const placeholderPart = createPartFromText(
          `[Uploaded Artifact: "${fileName}"]`,
        );
        newParts.push(placeholderPart);

        if (this.attachFileReference) {
          const filePart = await this.buildFileReferencePart(
            invocationContext,
            fileName,
            version,
            inlineData.mimeType,
          );
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

    const state = invocationContext.session.state;
    const key = `${this.name}:pending_delta`;
    const existing = (state[key] as Record<string, number>) || {};
    state[key] = {...existing, ...pendingDelta};
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
    const key = `${this.name}:pending_delta`;
    const pendingDelta = callbackContext.state.get<Record<string, number>>(key);
    if (pendingDelta && Object.keys(pendingDelta).length > 0) {
      Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
    }
    if (pendingDelta !== undefined) {
      delete callbackContext.invocationContext.session.state[key];
      delete callbackContext.actions.stateDelta[key];
    }
    return undefined;
  }

  private async buildFileReferencePart(
    invocationContext: InvocationContext,
    filename: string,
    version: number,
    mimeType?: string,
  ): Promise<Part | undefined> {
    try {
      const artifactVersion =
        await invocationContext.artifactService!.getArtifactVersion({
          filename,
          version,
        });

      if (
        !artifactVersion ||
        !artifactVersion.canonicalUri ||
        !isModelAccessibleUri(artifactVersion.canonicalUri)
      ) {
        return undefined;
      }

      const resolvedMimeType = mimeType || artifactVersion.mimeType || '';

      return {
        fileData: {
          fileUri: artifactVersion.canonicalUri,
          mimeType: resolvedMimeType,
          displayName: filename,
        },
      };
    } catch (e) {
      logger.warn(`Failed to resolve artifact version for ${filename}: ${e}`);
      return undefined;
    }
  }
}
