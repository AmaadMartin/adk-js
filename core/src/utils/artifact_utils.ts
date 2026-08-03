/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {
  fileHasUserNamespace,
  USER_NAMESPACE_PREFIX,
} from '../artifacts/base_artifact_service.js';
import {
  File,
  FileContentEncoding,
} from '../code_executors/code_execution_utils.js';
import {base64Encode} from './env_aware_utils.js';
import {logger} from './logger.js';

/**
 * Saves code-executor output files to the session artifact service.
 *
 * Persistence is opportunistic: when the invocation carries no artifact
 * service, nothing is saved and an empty map is returned, because the files
 * have already been produced and refusing them would turn a working
 * configuration into a hard failure. A save that fails for one file is logged
 * and does not abort the remaining files for the same reason.
 *
 * Files must be passed with the names the executor reported. Artifact services
 * version by filename, so a second `output.txt` is that artifact's next
 * version rather than a new key.
 *
 * @param context The context owning the session's artifact service.
 * @param files The files to persist.
 * @return A map of artifact filename to saved version, empty when nothing was
 *     saved.
 */
export async function saveFilesAsArtifacts(
  context: Context,
  files: File[],
): Promise<Record<string, number>> {
  if (!context.invocationContext.artifactService) {
    logger.debug(
      `No artifact service is configured; ${files.length} file(s) were not ` +
        'saved as artifacts.',
    );
    return {};
  }

  const savedArtifacts: Record<string, number> = {};

  for (const file of files) {
    // Filenames originate from executed code, so they must not be able to
    // widen an artifact beyond the session that produced it.
    if (fileHasUserNamespace(file.name)) {
      logger.warn(
        `Refused to save '${file.name}' as an artifact: names starting with ` +
          `'${USER_NAMESPACE_PREFIX}' are not accepted from produced files.`,
      );
      continue;
    }

    // `Part.inlineData.data` is base64; any other encoding the executor
    // reported has to be converted before the artifact service stores it.
    const data =
      file.contentEncoding === FileContentEncoding.UTF8
        ? base64Encode(file.content)
        : file.content;

    try {
      savedArtifacts[file.name] = await context.saveArtifact(file.name, {
        inlineData: {data, mimeType: file.mimeType},
      });
    } catch (e: unknown) {
      logger.warn(
        `Failed to save '${file.name}' as an artifact: ${(e as Error).message}`,
      );
    }
  }

  return savedArtifacts;
}
