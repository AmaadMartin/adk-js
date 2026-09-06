/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

import {InvocationContext} from '../agents/invocation_context.js';
import {SessionArtifactService} from '../artifacts/session_artifact_service.js';
import {base64ByteLength} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {BasePlugin} from './base_plugin.js';

/**
 * URI schemes the model connectors can fetch directly. Vertex exposes `gs://`
 * while hosted endpoints use HTTP(S).
 */
const MODEL_ACCESSIBLE_URI_SCHEME = /^(gs|https?):/i;

const BYTES_PER_MB = 1024 * 1024;

/**
 * The largest blob the Gemini API accepts as inline data:
 * https://ai.google.dev/gemini-api/docs/files
 *
 * A saved artifact is not out of reach of that limit: `LoadArtifactsTool`
 * pushes the artifact back into the request as an inline part, so an oversized
 * artifact would build a request the API rejects.
 */
const MAX_INLINE_DATA_SIZE_BYTES = 20 * BYTES_PER_MB;

/**
 * Options for {@link SaveFilesAsArtifactsPlugin}.
 */
export interface SaveFilesAsArtifactsPluginOptions {
  /**
   * Whether to attach a file reference to the user message. If `false`, files
   * are only persisted as artifacts without adding a reference, and they are
   * not directly accessible to the model. Defaults to `true`.
   */
  attachFileReference?: boolean;
}

/**
 * A plugin that saves files embedded in user messages as artifacts.
 *
 * This is useful to allow users to upload files in the chat experience and have
 * those files available to the agent within the current session.
 *
 * `Blob.displayName` determines the file name. By default, artifacts are
 * session-scoped; for cross-session persistence, prefix the filename with
 * `user:`. Artifacts with the same name are overwritten (the artifact service
 * versions them). A placeholder with the artifact name replaces the embedded
 * file in the user message so the model knows where to find the file. Consider
 * adding the {@link LoadArtifactsTool} (`LOAD_ARTIFACTS`) to the agent, or
 * loading the artifacts in your own tool, to use the files.
 *
 * Example:
 * ```typescript
 * const runner = new InMemoryRunner({
 *   agent,
 *   plugins: [new SaveFilesAsArtifactsPlugin()],
 * });
 * ```
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  private readonly attachFileReference: boolean;

  /**
   * Initializes the save-files-as-artifacts plugin.
   *
   * @param name The name of the plugin instance.
   * @param options Configuration options for the plugin.
   */
  constructor(
    name = 'save_files_as_artifacts_plugin',
    options: SaveFilesAsArtifactsPluginOptions = {},
  ) {
    super(name);
    this.attachFileReference = options.attachFileReference ?? true;
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    const artifactService = invocationContext.artifactService;
    if (!artifactService) {
      logger.warn(
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be enabled.',
      );
      return undefined;
    }

    if (!userMessage.parts || userMessage.parts.length === 0) {
      return undefined;
    }

    const newParts: Part[] = [];
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
          logger.debug(
            `No displayName found, using generated filename: ${fileName}`,
          );
        }
        const fileSize = base64ByteLength(inlineData.data ?? '');
        if (fileSize > MAX_INLINE_DATA_SIZE_BYTES) {
          const errorMessage =
            `File ${fileName} (${(fileSize / BYTES_PER_MB).toFixed(2)} MB) ` +
            `exceeds the maximum supported size of ` +
            `${MAX_INLINE_DATA_SIZE_BYTES / BYTES_PER_MB}MB. ` +
            `Please upload a smaller file.`;
          logger.warn(errorMessage);
          newParts.push({text: `[Upload Error: ${errorMessage}]`});
          modified = true;
          continue;
        }

        // Shallow copy (mirrors adk-python's `copy.copy`): the artifact service
        // may retain this reference, so detach the part's own fields from the
        // caller's object. The `inlineData` payload itself is still shared.
        const version = await artifactService.saveArtifact({
          filename: fileName,
          artifact: {...part},
        });

        newParts.push({text: `[Uploaded Artifact: "${fileName}"]`});

        if (this.attachFileReference) {
          const filePart = await buildFileReferencePart(artifactService, {
            filename: fileName,
            version,
            mimeType: inlineData.mimeType,
          });
          if (filePart) {
            newParts.push(filePart);
          }
        }

        modified = true;
        logger.debug(`Successfully saved artifact: ${fileName}`);
      } catch (e) {
        logger.error(`Failed to save artifact for part ${i}: ${e}`);
        newParts.push(part);
      }
    }

    if (!modified) {
      return undefined;
    }

    return {role: userMessage.role, parts: newParts};
  }
}

/**
 * Builds a `fileData` reference part when the saved artifact resolves to a
 * model-accessible canonical URI. Returns `undefined` (and never throws) when
 * the version cannot be resolved or the URI is not model-accessible.
 */
async function buildFileReferencePart(
  artifactService: SessionArtifactService,
  {
    filename,
    version,
    mimeType,
  }: {
    filename: string;
    version: number;
    mimeType?: string;
  },
): Promise<Part | undefined> {
  const artifactVersion = await artifactService
    .getArtifactVersion({filename, version})
    .catch((exc) => {
      logger.warn(`Failed to resolve artifact version for ${filename}: ${exc}`);
      return undefined;
    });

  if (
    !artifactVersion?.canonicalUri ||
    !MODEL_ACCESSIBLE_URI_SCHEME.test(artifactVersion.canonicalUri)
  ) {
    return undefined;
  }

  return {
    fileData: {
      fileUri: artifactVersion.canonicalUri,
      mimeType: mimeType ?? artifactVersion.mimeType,
      displayName: filename,
    },
  };
}
