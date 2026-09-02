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
import {namesSupportedDatabaseBackend} from './db/operations.js';
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

  // A driver-suffixed URL such as `postgresql+asyncpg://` is not one adk-js
  // accepts, but it does name a database backend. Routing it here lets the
  // service explain the suffix, rather than reporting that no session service
  // claims the URI.
  if (isDatabaseConnectionString(uri) || namesSupportedDatabaseBackend(uri)) {
    return new DatabaseSessionService(uri);
  }

  if (isVertexAiConnectionString(uri)) {
    // uri is something like vertexai://projects/abc/locations/us-central1
    return new VertexAiSessionService({});
  }

  throw new Error(`Unsupported session service URI: ${redactUriPassword(uri)}`);
}
