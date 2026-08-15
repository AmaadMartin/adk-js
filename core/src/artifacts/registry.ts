/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getServiceRegistry,
  ServiceFactoryOptions,
} from '../services/service_registry.js';
import {redactUriPassword} from '../utils/redact_uri.js';
import {BaseArtifactService} from './base_artifact_service.js';

export function getArtifactServiceFromUri(
  uri: string,
  options?: ServiceFactoryOptions,
): BaseArtifactService {
  const service = getServiceRegistry().createArtifactService(uri, options);

  if (!service) {
    throw new Error(
      `Unsupported artifact service URI: ${redactUriPassword(uri)}`,
    );
  }

  return service;
}
