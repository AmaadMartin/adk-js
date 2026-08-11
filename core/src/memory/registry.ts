/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {redactUriPassword} from '../utils/redact_uri.js';
import {
  AgentEngineResourceName,
  parseAgentEngineResourceName,
} from '../utils/vertex_ai_utils.js';
import {BaseMemoryService} from './base_memory_service.js';
import {
  InMemoryMemoryService,
  isInMemoryConnectionString,
} from './in_memory_memory_service.js';
import {VertexAiMemoryBankService} from './vertex_ai_memory_bank_service.js';

const AGENT_ENGINE_SCHEME = 'agentengine://';

/**
 * Parses the part of an `agentengine://` URI that follows the scheme.
 *
 * The resource is either a bare agent engine id, in which case the project and
 * the location come from the environment, or a fully qualified resource name.
 * Both forms resolve to the bare id, because `VertexAiMemoryBankService`
 * expects an id rather than a path.
 */
function parseAgentEngineUri(resource: string): AgentEngineResourceName {
  if (!resource) {
    throw new Error(
      'Agent engine resource name or resource id cannot be empty.',
    );
  }

  if (!resource.includes('/')) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION;

    if (!projectId || !location) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must both be set to ' +
          'use an agent engine resource id. Use the full resource name ' +
          'projects/{project}/locations/{location}/reasoningEngines/{id} to ' +
          'avoid that requirement.',
      );
    }

    return {projectId, location, agentEngineId: resource};
  }

  const parsed = parseAgentEngineResourceName(resource);

  if (!parsed) {
    throw new Error(
      'Agent engine resource name is mal-formatted. It should be of format: ' +
        'projects/{project}/locations/{location}/reasoningEngines/{id}',
    );
  }

  return parsed;
}

export function getMemoryServiceFromUri(uri: string): BaseMemoryService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryMemoryService();
  }

  if (uri.startsWith(AGENT_ENGINE_SCHEME)) {
    return new VertexAiMemoryBankService(
      parseAgentEngineUri(uri.slice(AGENT_ENGINE_SCHEME.length)),
    );
  }

  throw new Error(`Unsupported memory service URI: ${redactUriPassword(uri)}`);
}
