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
import {SessionArtifactService} from '../artifacts/session_artifact_service.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Schemes the current LLM connectors can read. Vertex exposes `gs://` while
 * hosted endpoints use HTTPS. Expand this list when `BaseLlm` surfaces
 * provider capabilities.
 */
const MODEL_ACCESSIBLE_URI_SCHEMES = new Set(['gs', 'https', 'http']);

const BYTES_PER_MB = 1024 * 1024;

/**
 * Largest inline blob the Gemini API accepts, as documented at
 * https://ai.google.dev/gemini-api/docs/files. Measured on the decoded bytes,
 * not on the base64 text that carries them.
 */
const MAX_INLINE_DATA_SIZE_BYTES = 20 * BYTES_PER_MB;

const DEFAULT_PLUGIN_NAME = 'save_files_as_artifacts_plugin';

/**
 * Suffix of the session state key holding artifact versions that are saved but
 * not yet reported on the event stream. Kept in snake_case because the value
 * is persisted session state that adk-python reads under the same key.
 */
const PENDING_DELTA_KEY_SUFFIX = ':pending_delta';

/** Options for configuring {@link SaveFilesAsArtifactsPlugin}. */
export interface SaveFilesAsArtifactsPluginOptions {
  /**
   * Plugin instance identifier. Defaults to
   * `'save_files_as_artifacts_plugin'`.
   */
  name?: string;
  /**
   * Whether to attach a model-readable file reference next to the placeholder.
   * When false the bytes are still saved, but the model cannot read the file
   * directly. Defaults to true.
   */
  attachFileReference?: boolean;
}

/** True when `value` is a filename to artifact-version record. */
function isArtifactDelta(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((version) => typeof version === 'number')
  );
}

/** True when a model connector can read the file at `uri` directly. */
function isModelAccessibleUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return MODEL_ACCESSIBLE_URI_SCHEMES.has(parsed.protocol.slice(0, -1));
}

/**
 * Builds a file reference part for a saved artifact, or `undefined` when the
 * artifact has no URI a model connector can read.
 */
async function buildFileReferencePart(params: {
  artifactService: SessionArtifactService;
  filename: string;
  version: number;
  mimeType?: string;
}): Promise<Part | undefined> {
  const {artifactService, filename, version, mimeType} = params;

  let artifactVersion: ArtifactVersion | undefined;
  try {
    artifactVersion = await artifactService.getArtifactVersion({
      filename,
      version,
    });
  } catch (e: unknown) {
    logger.warn(
      `Failed to resolve artifact version for ${filename}: ${formatError(e)}`,
    );
    return undefined;
  }

  const canonicalUri = artifactVersion?.canonicalUri;
  if (!canonicalUri || !isModelAccessibleUri(canonicalUri)) {
    return undefined;
  }

  return {
    fileData: {
      fileUri: canonicalUri,
      // The blob's own mime type wins, matching adk-python.
      mimeType: mimeType || artifactVersion?.mimeType,
      displayName: filename,
    },
  };
}

/**
 * A plugin that saves files embedded in user messages as artifacts.
 *
 * This is useful to allow users to upload files in the chat experience and
 * have those files available to the agent within the current session.
 *
 * `Blob.displayName` determines the file name. Artifacts are session-scoped;
 * prefix the filename with `user:` for cross-session persistence. An artifact
 * with the same name is overwritten. The embedded file is replaced with a
 * placeholder naming the artifact, so the model knows where to find it. Add
 * the `loadArtifacts` tool to the agent, or load the artifacts in your own
 * tool, to use the files.
 *
 * @example
 * ```typescript
 * const runner = new InMemoryRunner({
 *   agent: myAgent,
 *   plugins: [new SaveFilesAsArtifactsPlugin()],
 * });
 * ```
 */
export class SaveFilesAsArtifactsPlugin extends BasePlugin {
  private readonly attachFileReference: boolean;

  /**
   * @param options Plugin name and whether to attach a file reference.
   */
  constructor(options: SaveFilesAsArtifactsPluginOptions = {}) {
    super(options.name ?? DEFAULT_PLUGIN_NAME);
    this.attachFileReference = options.attachFileReference ?? true;
  }

  /** Session state key this instance stashes unreported versions under. */
  private get pendingDeltaKey(): string {
    return `${this.name}${PENDING_DELTA_KEY_SUFFIX}`;
  }

  /** Saves every file attached to the user message as an artifact. */
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
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be' +
          ' enabled.',
      );
      return userMessage;
    }

    if (!userMessage.parts?.length) {
      return undefined;
    }

    const newParts: Part[] = [];
    const pendingDelta: Record<string, number> = {};
    let modified = false;

    for (const [i, part] of userMessage.parts.entries()) {
      const inlineData = part.inlineData;
      if (!inlineData) {
        newParts.push(part);
        continue;
      }

      try {
        // `@google/genai` types `Blob.data` as base64 text while adk-python
        // holds raw bytes, so decode the length to keep the limit meaning the
        // same thing in both SDKs.
        const fileSize = Buffer.byteLength(inlineData.data ?? '', 'base64');

        let fileName = inlineData.displayName;
        if (!fileName) {
          fileName = `artifact_${invocationContext.invocationId}_${i}`;
          logger.info(
            `No displayName found, using generated filename: ${fileName}`,
          );
        }

        if (fileSize > MAX_INLINE_DATA_SIZE_BYTES) {
          const errorMessage =
            `File ${fileName} (${(fileSize / BYTES_PER_MB).toFixed(2)} MB)` +
            ` exceeds the maximum supported size of` +
            ` ${(MAX_INLINE_DATA_SIZE_BYTES / BYTES_PER_MB).toFixed(0)}MB.` +
            ` Please upload a smaller file.`;
          logger.warn(errorMessage);
          newParts.push({text: `[Upload Error: ${errorMessage}]`});
          modified = true;
          continue;
        }

        // Copy the part so that a later mutation of the user message cannot
        // reach the stored artifact.
        const version = await artifactService.saveArtifact({
          filename: fileName,
          artifact: {...part},
        });

        newParts.push({text: `[Uploaded Artifact: "${fileName}"]`});

        if (this.attachFileReference) {
          const fileReferencePart = await buildFileReferencePart({
            artifactService,
            filename: fileName,
            version,
            mimeType: inlineData.mimeType,
          });
          if (fileReferencePart) {
            newParts.push(fileReferencePart);
          }
        }

        pendingDelta[fileName] = version;
        modified = true;
        logger.info(`Successfully saved artifact: ${fileName}`);
      } catch (e: unknown) {
        logger.error(
          `Failed to save artifact for part ${i}: ${formatError(e)}`,
        );
        newParts.push(part);
      }
    }

    if (!modified) {
      return undefined;
    }

    // The versions are stashed on the session state because a user message has
    // no event actions of its own to report them on.
    const state = invocationContext.session.state;
    const stashed = state[this.pendingDeltaKey];
    state[this.pendingDeltaKey] = {
      ...(isArtifactDelta(stashed) ? stashed : {}),
      ...pendingDelta,
    };

    return {role: userMessage.role, parts: newParts};
  }

  /** Reports the stashed artifact versions on the agent's event actions. */
  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    const key = this.pendingDeltaKey;
    const stashed = callbackContext.state.get<unknown>(key);

    if (!isArtifactDelta(stashed)) {
      if (stashed !== undefined) {
        logger.warn(
          `Discarding a malformed pending artifact delta under state key` +
            ` "${key}".`,
        );
        callbackContext.state.set(key, {});
      }
      return undefined;
    }

    // An empty stash is left alone: clearing it would write a state delta, and
    // the agent turns any delta into an extra event.
    if (Object.keys(stashed).length > 0) {
      Object.assign(callbackContext.actions.artifactDelta, stashed);
      callbackContext.state.set(key, {});
    }
    return undefined;
  }
}
