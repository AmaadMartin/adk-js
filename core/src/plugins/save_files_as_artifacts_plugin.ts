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
 * Checks whether the given URI uses a scheme supported for direct model access (`gs://`, `https://`, `http://`).
 */
export function isModelAccessibleUri(uri: string): boolean {
  try {
    return ['gs:', 'https:', 'http:'].includes(new URL(uri).protocol);
  } catch {
    return false;
  }
}

/**
 * Constructs a `FileData` reference part if the artifact URI is model-accessible (`gs://`, `https://`, `http://`).
 */
export async function buildFileReferencePart({
  invocationContext,
  filename,
  version,
  mimeType,
  displayName,
}: {
  invocationContext: InvocationContext;
  filename: string;
  version: number;
  mimeType?: string;
  displayName: string;
}): Promise<Part | undefined> {
  const artifactService = invocationContext.artifactService;
  if (!artifactService) {
    return undefined;
  }

  try {
    const artifactVersion = await artifactService.getArtifactVersion({
      filename,
      version,
    });

    if (
      !artifactVersion?.canonicalUri ||
      !isModelAccessibleUri(artifactVersion.canonicalUri)
    ) {
      return undefined;
    }

    return {
      fileData: {
        fileUri: artifactVersion.canonicalUri,
        mimeType: mimeType || artifactVersion.mimeType,
        displayName,
      },
    };
  } catch (exc) {
    logger.warn(
      `Failed to resolve artifact version for ${filename}: ${exc instanceof Error ? exc.message : exc}`,
    );
    return undefined;
  }
}

/**
 * Processes user message parts, saving inline data as session artifacts via `invocationContext.artifactService`
 * and replacing them with clean structured placeholders (`[Uploaded Artifact: "${displayName}"]`).
 */
export async function processUserMessageArtifacts(
  invocationContext: InvocationContext,
  userMessage: Content,
  options: {attachFileReference?: boolean} = {},
): Promise<{
  newContent?: Content;
  pendingDelta?: Record<string, number>;
}> {
  if (!invocationContext.artifactService) {
    logger.warn(
      'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be enabled.',
    );
    return {};
  }

  if (!userMessage.parts || userMessage.parts.length === 0) {
    return {};
  }

  const newParts: Part[] = [];
  const pendingDelta: Record<string, number> = {};
  let modified = false;
  const attachFileReference = options.attachFileReference ?? true;

  for (let i = 0; i < userMessage.parts.length; i++) {
    const part: Part = userMessage.parts[i];
    if (!part.inlineData) {
      newParts.push(part);
      continue;
    }

    try {
      const inlineData = part.inlineData;
      const fileName =
        inlineData.displayName ||
        `artifact_${invocationContext.invocationId}_${i}`;
      if (!inlineData.displayName) {
        logger.info(
          `No display_name found, using generated filename: ${fileName}`,
        );
      }

      const version = await invocationContext.artifactService.saveArtifact({
        filename: fileName,
        artifact: structuredClone(part),
      });

      newParts.push(createPartFromText(`[Uploaded Artifact: "${fileName}"]`));

      if (attachFileReference) {
        const filePart = await buildFileReferencePart({
          invocationContext,
          filename: fileName,
          version,
          mimeType: inlineData.mimeType,
          displayName: fileName,
        });
        if (filePart) {
          newParts.push(filePart);
        }
      }
      pendingDelta[fileName] = version;
      modified = true;
      logger.info(`Successfully saved artifact: ${fileName}`);
    } catch (e) {
      logger.error(
        `Failed to save artifact for part ${i}: ${e instanceof Error ? e.message : e}`,
      );
      newParts.push(part);
    }
  }

  if (modified) {
    return {
      newContent: {
        role: userMessage.role,
        parts: newParts,
      },
      pendingDelta,
    };
  }

  return {};
}

/**
 * Options for `SaveFilesAsArtifactsPlugin`.
 */
export interface SaveFilesAsArtifactsOptions {
  attachFileReference?: boolean;
}

/**
 * A plugin that saves files embedded in user messages (`inlineData`) as artifacts.
 *
 * This allows users to upload files in the chat experience and have those files
 * available to the agent within the current session. Inline data parts in the user message
 * are replaced with clean structured placeholders (`[Uploaded Artifact: "${displayName}"]`).
 * If the artifact URI is model-accessible (`gs://` or `https://`), a `FileData` reference part
 * is attached so the model can inspect the file natively.
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  readonly attachFileReference: boolean;

  constructor(
    nameOrOptions?: string | (SaveFilesAsArtifactsOptions & {name?: string}),
    options?: SaveFilesAsArtifactsOptions,
  ) {
    let name = 'save_files_as_artifacts_plugin';
    let opts: SaveFilesAsArtifactsOptions | undefined = options;

    if (typeof nameOrOptions === 'string') {
      name = nameOrOptions;
    } else if (nameOrOptions && typeof nameOrOptions === 'object') {
      name = nameOrOptions.name || name;
      opts = nameOrOptions;
    }

    super(name);
    this.attachFileReference = opts?.attachFileReference ?? true;
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    const {newContent, pendingDelta} = await processUserMessageArtifacts(
      invocationContext,
      userMessage,
      {
        attachFileReference: this.attachFileReference,
      },
    );

    if (newContent && pendingDelta) {
      const state = invocationContext.session.state;
      const pendingDeltaKey = `${this.name}:pendingDelta`;
      const existingDelta =
        (state[pendingDeltaKey] as Record<string, number>) || {};
      state[pendingDeltaKey] = {...existingDelta, ...pendingDelta};
      return newContent;
    }

    return undefined;
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const pendingDeltaKey = `${this.name}:pendingDelta`;
    const pendingDelta = callbackContext.state.get(pendingDeltaKey) as
      Record<string, number> | undefined;
    if (pendingDelta && typeof pendingDelta === 'object') {
      Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
      callbackContext.state.set(pendingDeltaKey, {});
    }
    return undefined;
  }
}
