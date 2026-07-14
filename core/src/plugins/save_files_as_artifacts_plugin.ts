/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {ArtifactVersion} from '../artifacts/base_artifact_service.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

const MODEL_ACCESSIBLE_URI_SCHEMES = new Set(['gs:', 'https:', 'http:']);

/**
 * Options for {@link SaveFilesAsArtifactsPlugin}.
 */
export interface SaveFilesAsArtifactsPluginOptions {
  /**
   * Whether to attach a file reference to the user message. If false, only save
   * the files as artifacts without adding a file reference, and the files will not
   * be directly accessible to the model. Defaults to true.
   */
  attachFileReference?: boolean;
}

/**
 * A plugin that saves files embedded in user messages as artifacts.
 *
 * This is useful to allow users to upload files in the chat experience and have
 * those files available to the agent within the current session.
 *
 * We use Blob.displayName to determine the file name. By default, artifacts are
 * session-scoped. A placeholder with the artifact name will be put in place of
 * the embedded file in the user message so the model knows where to find the
 * file. You may want to add load_artifacts tool to the agent, or load the
 * artifacts in your own tool to use the files.
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  private readonly attachFileReference: boolean;

  /**
   * Initialize the save files as artifacts plugin.
   *
   * @param name The name of the plugin instance.
   * @param options Configuration options for the plugin.
   */
  constructor(
    name = 'save_files_as_artifacts_plugin',
    options?: SaveFilesAsArtifactsPluginOptions,
  ) {
    super(name);
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
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be enabled.',
      );
      return;
    }

    if (!userMessage.parts?.length) {
      return;
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
            `No display_name found, using generated filename: ${fileName}`,
          );
        }

        const version = await invocationContext.artifactService.saveArtifact({
          filename: fileName,
          artifact: part,
        });

        newParts.push({text: `[Uploaded Artifact: "${fileName}"]`});

        if (this.attachFileReference) {
          const filePart = await buildFileReferencePart({
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
      }
    }

    if (!modified) {
      return undefined;
    }
    const state = invocationContext.session.state;
    const key = `${this.name}:pendingDelta`;
    const existingDelta =
      (state[key] as Record<string, number> | undefined) || {};
    state[key] = {...existingDelta, ...pendingDelta};
    return {role: userMessage.role, parts: newParts};
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const key = `${this.name}:pendingDelta`;
    const pendingDelta = callbackContext.state.get<Record<string, number>>(key);
    if (
      pendingDelta &&
      typeof pendingDelta === 'object' &&
      Object.keys(pendingDelta).length > 0
    ) {
      Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
      callbackContext.state.set(key, {});
    }
    return undefined;
  }
}

async function buildFileReferencePart({
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
  let artifactVersion: ArtifactVersion | undefined;
  try {
    artifactVersion = await artifactService.getArtifactVersion({
      filename,
      version,
    });
  } catch (exc) {
    logger.warn(`Failed to resolve artifact version for ${filename}: ${exc}`);
    return undefined;
  }

  if (
    !artifactVersion ||
    !artifactVersion.canonicalUri ||
    !isModelAccessibleUri(artifactVersion.canonicalUri)
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
}

function isModelAccessibleUri(uri: string): boolean {
  return (
    URL.canParse(uri) && MODEL_ACCESSIBLE_URI_SCHEMES.has(new URL(uri).protocol)
  );
}
