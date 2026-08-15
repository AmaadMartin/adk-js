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
import {BaseSessionService} from './base_session_service.js';

export function getSessionServiceFromUri(
  uri: string,
  options?: ServiceFactoryOptions,
): BaseSessionService {
  const service = getServiceRegistry().createSessionService(uri, options);

  if (!service) {
    throw new Error(
      `Unsupported session service URI: ${redactUriPassword(uri)}`,
    );
  }

  return service;
}
