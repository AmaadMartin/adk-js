/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, Part} from '@google/genai';

import type {BaseAgent} from '../agents/base_agent.js';
import type {Context} from '../agents/context.js';
import type {InvocationContext} from '../agents/invocation_context.js';
import type {SessionArtifactService} from '../artifacts/session_artifact_service.js';
import {State} from '../sessions/state.js';
import {logger} from '../utils/logger.js';

import {BasePlugin} from './base_plugin.js';

/**
 * URI schemes that the model connectors can access directly. Vertex exposes
 * `gs://` while hosted endpoints use HTTP(S). Expand this set when more
 * provider capabilities are surfaced.
 */
const MODEL_ACCESSIBLE_URI_SCHEMES = new Set(['gs', 'https', 'http']);

/**
 * The session-state key holding the pending `filename -> version` map handed
 * off from `onUserMessageCallback` to the next `beforeAgentCallback`.
 *
 * The `temp:` prefix keeps this bookkeeping out of durable session state: it is
 * only needed within a single invocation, and session services skip persisting
 * `temp:`-prefixed keys.
 */
function pendingDeltaKey(pluginName: string): string {
  return `${State.TEMP_PREFIX}${pluginName}:pending_delta`;
}

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
          logger.debug(
            `No displayName found, using generated filename: ${fileName}`,
          );
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

        pendingDelta[fileName] = version;
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

    const key = pendingDeltaKey(this.name);
    const existing =
      (invocationContext.session.state[key] as Record<string, number>) ?? {};
    invocationContext.session.state[key] = {...existing, ...pendingDelta};

    return {role: userMessage.role, parts: newParts};
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const key = pendingDeltaKey(this.name);
    const pendingDelta = callbackContext.state.get<Record<string, number>>(key);
    if (pendingDelta && Object.keys(pendingDelta).length > 0) {
      Object.assign(callbackContext.actions.artifactDelta, pendingDelta);
      callbackContext.state.set(key, {});
    }
    return undefined;
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
    !isModelAccessibleUri(artifactVersion.canonicalUri)
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

/**
 * Returns whether the given URI uses a scheme the model can access directly.
 * Scheme-less strings return `false`.
 */
function isModelAccessibleUri(uri: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  if (!match) {
    return false;
  }
  return MODEL_ACCESSIBLE_URI_SCHEMES.has(match[1].toLowerCase());
}
