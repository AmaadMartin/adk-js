/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {
  File,
  FileContentEncoding,
} from '../code_executors/code_execution_utils.js';
import {logger} from './logger.js';

/**
 * Filename prefix that widens an artifact from session scope to cross-session
 * user scope. See `in_memory_artifact_service.ts`.
 */
const USER_NAMESPACE_PREFIX = 'user:';

/** One file successfully persisted to the artifact service. */
export interface SavedArtifact {
  filename: string;
  version: number;
}

/** One file that could not be persisted to the artifact service. */
export interface ArtifactSaveError {
  filename: string;
  error: string;
}

/** Outcome of persisting a batch of files to the artifact service. */
export interface SaveFilesAsArtifactsResult {
  savedArtifacts: SavedArtifact[];
  artifactSaveErrors: ArtifactSaveError[];
}

/**
 * Saves each file as an artifact of the current session.
 *
 * Every file is accounted for in exactly one of the two returned arrays: a
 * failure is reported rather than thrown, because the files have already been
 * produced and failing the whole batch would discard the successful saves.
 *
 * @param context The context owning the session's artifact service.
 * @param files The files to persist.
 * @return The per-file outcome, or `undefined` when the invocation has no
 *     artifact service configured, so callers can treat artifact persistence as
 *     best-effort.
 */
export async function saveFilesAsArtifacts(
  context: Context,
  files: File[],
): Promise<SaveFilesAsArtifactsResult | undefined> {
  if (!context.invocationContext.artifactService) {
    logger.warn(
      `No artifact service is configured; ${files.length} file(s) were not ` +
        'saved as artifacts.',
    );
    return undefined;
  }

  const savedArtifacts: SavedArtifact[] = [];
  const artifactSaveErrors: ArtifactSaveError[] = [];

  for (const file of files) {
    // Filenames originate from executed code, so they must not be able to
    // widen an artifact beyond the session that produced it.
    if (file.name.startsWith(USER_NAMESPACE_PREFIX)) {
      const error =
        `Artifact names starting with '${USER_NAMESPACE_PREFIX}' are not ` +
        'accepted from produced files.';
      logger.warn(`Refused to save '${file.name}' as an artifact: ${error}`);
      artifactSaveErrors.push({filename: file.name, error});
      continue;
    }

    const data =
      file.contentEncoding === FileContentEncoding.BASE64
        ? file.content
        : Buffer.from(file.content, file.contentEncoding).toString('base64');

    try {
      const version = await context.saveArtifact(file.name, {
        inlineData: {data, mimeType: file.mimeType},
      });
      savedArtifacts.push({filename: file.name, version});
    } catch (e: unknown) {
      const error = (e as Error).message;
      logger.error(`Failed to save '${file.name}' as an artifact: ${error}`);
      artifactSaveErrors.push({filename: file.name, error});
    }
  }

  return {savedArtifacts, artifactSaveErrors};
}
