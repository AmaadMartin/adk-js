/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';
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
    // Only the authority names the bucket; a path component is not part of a
    // GCS bucket name (matches adk-python's urlparse(uri).netloc).
    const {hostname: bucket, pathname} = new URL(uri);

    if (pathname && pathname !== '/') {
      logger.warn(
        `[getArtifactServiceFromUri] Ignoring path "${pathname}" in artifact service URI "${uri}"; artifacts are stored from the root of bucket "${bucket}".`,
      );
    }

    return new GcsArtifactService(bucket);
  }

  if (uri.startsWith('file://')) {
    const rootDir = uri.split('://')[1];

    return new FileArtifactService(rootDir);
  }

  throw new Error(`Unsupported artifact service URI: ${uri}`);
}
