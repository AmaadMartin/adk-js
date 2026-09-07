/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {redactUriPassword} from '../utils/redact_uri.js';
import {BaseMemoryService} from './base_memory_service.js';
import {
  InMemoryMemoryService,
  isInMemoryConnectionString,
} from './in_memory_memory_service.js';
import {
  VertexAiMemoryBankService,
  VertexAiMemoryBankServiceOptions,
} from './vertex_ai_memory_bank_service.js';

const AGENT_ENGINE_SCHEME = 'agentengine://';

/**
 * Resolves the `agentengine://` remainder into Memory Bank options.
 *
 * The remainder is either a bare resource id (`123`), in which case the
 * project and location come from the environment, or a fully qualified
 * `projects/{project}/locations/{location}/reasoningEngines/{id}` name.
 */
function parseAgentEngineOptions(
  resource: string,
): VertexAiMemoryBankServiceOptions {
  if (!resource) {
    throw new Error(
      'Agent engine resource name or resource id cannot be empty.',
    );
  }

  if (!resource.includes('/')) {
    return {
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION,
      agentEngineId: resource,
    };
  }

  const parts = resource.split('/');
  if (
    parts.length !== 6 ||
    parts[0] !== 'projects' ||
    parts[2] !== 'locations' ||
    parts[4] !== 'reasoningEngines'
  ) {
    throw new Error(
      'Agent engine resource name is mal-formatted. It should be of format: projects/{project_id}/locations/{location}/reasoningEngines/{resource_id}',
    );
  }

  return {projectId: parts[1], location: parts[3], agentEngineId: parts[5]};
}

export function getMemoryServiceFromUri(uri: string): BaseMemoryService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryMemoryService();
  }

  if (uri.startsWith(AGENT_ENGINE_SCHEME)) {
    // Sliced rather than split on '://' so a resource id containing '://'
    // cannot truncate the value.
    return new VertexAiMemoryBankService(
      parseAgentEngineOptions(uri.slice(AGENT_ENGINE_SCHEME.length)),
    );
  }

  throw new Error(`Unsupported memory service URI: ${redactUriPassword(uri)}`);
}
