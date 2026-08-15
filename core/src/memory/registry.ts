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
import {BaseMemoryService} from './base_memory_service.js';

export function getMemoryServiceFromUri(
  uri: string,
  options?: ServiceFactoryOptions,
): BaseMemoryService {
  const service = getServiceRegistry().createMemoryService(uri, options);

  if (!service) {
    throw new Error(
      `Unsupported memory service URI: ${redactUriPassword(uri)}`,
    );
  }

  return service;
}
