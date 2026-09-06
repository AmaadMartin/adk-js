/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {redactUriPassword} from '../utils/redact_uri.js';
import {BaseSessionService} from './base_session_service.js';
import {
  DatabaseSessionService,
  isDatabaseConnectionString,
} from './database_session_service.js';
import {
  InMemorySessionService,
  isInMemoryConnectionString,
} from './in_memory_session_service.js';
import {
  VertexAiSessionService,
  isVertexAiConnectionString,
} from './vertex_ai_session_service.js';

export function getSessionServiceFromUri(uri: string): BaseSessionService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemorySessionService();
  }

  // This claims a driver-suffixed URL such as `postgresql+asyncpg://` too, so
  // the service explains the suffix rather than the registry reporting that no
  // session service takes the URI.
  if (isDatabaseConnectionString(uri)) {
    return new DatabaseSessionService(uri);
  }

  if (isVertexAiConnectionString(uri)) {
    // uri is something like vertexai://projects/abc/locations/us-central1
    return new VertexAiSessionService({});
  }

  throw new Error(`Unsupported session service URI: ${redactUriPassword(uri)}`);
}
