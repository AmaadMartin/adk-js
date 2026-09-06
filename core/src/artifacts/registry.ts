/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';
import {redactUriPassword} from '../utils/redact_uri.js';
import {BaseArtifactService} from './base_artifact_service.js';
import {FileArtifactService} from './file_artifact_service.js';
import {GcsArtifactService} from './gcs_artifact_service.js';
import {
  InMemoryArtifactService,
  isInMemoryConnectionString,
} from './in_memory_artifact_service.js';

export function getArtifactServiceFromUri(uri: string): BaseArtifactService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryArtifactService();
  }

  if (uri.startsWith('gs://')) {
    return new GcsArtifactService(parseGcsBucketName(uri));
  }

  if (uri.startsWith('file://')) {
    const rootDir = uri.split('://')[1];

    return new FileArtifactService(rootDir);
  }

  throw new Error(
    `Unsupported artifact service URI: ${redactUriPassword(uri)}`,
  );
}

/**
 * Extracts the bucket name from a `gs://` artifact service URI.
 *
 * Only the host component names the bucket, because a GCS bucket name cannot
 * contain a `/`. A path is accepted and ignored, but it is reported, because
 * artifacts are stored from the root of the bucket rather than under the path
 * the caller wrote.
 *
 * @throws an Error naming the URI when it names no bucket, so the caller sees
 *     the value it passed rather than a later failure from the storage client.
 */
function parseGcsBucketName(uri: string): string {
  let bucket = '';
  let pathname = '';
  try {
    ({hostname: bucket, pathname} = new URL(uri));
  } catch {
    // Unparseable, so it names no bucket; reported by the check below.
  }

  if (!bucket) {
    throw new Error(
      `Invalid artifact service URI: ${redactUriPassword(uri)}. A gs:// URI ` +
        `must name a bucket, for example gs://my-bucket.`,
    );
  }

  if (pathname && pathname !== '/') {
    logger.warn(
      `[getArtifactServiceFromUri] Ignoring path "${pathname}" in artifact service URI "${redactUriPassword(uri)}"; artifacts are stored from the root of bucket "${bucket}".`,
    );
  }

  return bucket;
}
