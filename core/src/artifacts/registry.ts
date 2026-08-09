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
 * Only the authority names the bucket, because a GCS bucket name cannot
 * contain a `/` (this matches adk-python's `urlparse(uri).netloc`). A path is
 * accepted and ignored, but it is reported, because artifacts are stored from
 * the root of the bucket rather than under the path the caller wrote.
 *
 * @throws an Error naming the URI when it names no bucket, so the caller sees
 *     the value it passed instead of a later failure raised from inside the
 *     storage client.
 */
function parseGcsBucketName(uri: string): string {
  const parsed = tryParseUrl(uri);

  if (!parsed?.hostname) {
    throw new Error(
      `Invalid artifact service URI: ${redactUriPassword(uri)}. A gs:// URI ` +
        `must name a bucket, for example gs://my-bucket.`,
    );
  }

  const {hostname: bucket, pathname} = parsed;
  if (pathname && pathname !== '/') {
    logger.warn(
      `[getArtifactServiceFromUri] Ignoring path "${pathname}" in artifact service URI "${redactUriPassword(uri)}"; artifacts are stored from the root of bucket "${bucket}".`,
    );
  }

  return bucket;
}

/** Parses a URI, returning undefined when the URI is malformed. */
function tryParseUrl(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}
