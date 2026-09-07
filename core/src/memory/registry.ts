/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {redactUriPassword} from '../utils/redact_uri.js';
import {REASONING_ENGINE_NAME_PATTERN} from '../utils/vertex_ai_utils.js';
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
 * Resolves an `agentengine://` memory URI into Memory Bank options.
 *
 * `uri` must carry the `agentengine://` scheme, which `getMemoryServiceFromUri`
 * checks before it calls this. What follows the scheme is either a bare
 * resource id (`123`), in which case `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_CLOUD_LOCATION` must both be set, or a fully qualified
 * `projects/{project}/locations/{location}/reasoningEngines/{id}` name, which
 * needs no environment.
 */
export function parseAgentEngineMemoryUri(
  uri: string,
): VertexAiMemoryBankServiceOptions {
  // Sliced rather than split on '://' so a resource id containing '://'
  // cannot truncate the value.
  const resource = uri.slice(AGENT_ENGINE_SCHEME.length);

  if (!resource) {
    throw new Error(
      'Agent engine resource name or resource id cannot be empty.',
    );
  }

  if (!resource.includes('/')) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION;
    // Without both, the Vertex client either fails with a message that names
    // neither variable, or silently resolves to the global endpoint and misses
    // a Memory Bank that lives in a region.
    if (!projectId || !location) {
      throw new Error('GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.');
    }
    return {projectId, location, agentEngineId: resource};
  }

  const match = resource.match(REASONING_ENGINE_NAME_PATTERN);
  if (!match) {
    throw new Error(
      'Agent engine resource name is mal-formatted. It should be of format: projects/{project_id}/locations/{location}/reasoningEngines/{resource_id}',
    );
  }

  return {projectId: match[1], location: match[2], agentEngineId: match[3]};
}

export function getMemoryServiceFromUri(uri: string): BaseMemoryService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryMemoryService();
  }

  if (uri.startsWith(AGENT_ENGINE_SCHEME)) {
    return new VertexAiMemoryBankService(parseAgentEngineMemoryUri(uri));
  }

  throw new Error(`Unsupported memory service URI: ${redactUriPassword(uri)}`);
}
