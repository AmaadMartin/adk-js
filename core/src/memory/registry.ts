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

const AGENT_ENGINE_PREFIX = 'agentengine://';

const AGENT_ENGINE_RESOURCE_NAME_PATTERN =
  /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;

const AGENT_ENGINE_ID_PATTERN = /^\d+$/;

/**
 * Reads the part after `agentengine://` as either a bare engine id or a full
 * resource name. The bare form carries no project or location, so those come
 * from the environment, as they do for the other Agent Engine clients in this
 * package.
 */
function parseAgentEngineOptions(
  resource: string,
): VertexAiMemoryBankServiceOptions | undefined {
  if (AGENT_ENGINE_ID_PATTERN.test(resource)) {
    return {
      agentEngineId: resource,
      projectId: process.env['GOOGLE_CLOUD_PROJECT'],
      location: process.env['GOOGLE_CLOUD_LOCATION'],
    };
  }

  const match = AGENT_ENGINE_RESOURCE_NAME_PATTERN.exec(resource);
  if (!match) {
    return undefined;
  }
  const [, projectId, location, agentEngineId] = match;
  return {projectId, location, agentEngineId};
}

/**
 * Builds a memory service from a connection URI.
 *
 * Supported URIs:
 * - `memory://` for the in-memory memory service.
 * - `agentengine://<id>` or
 *   `agentengine://projects/<project>/locations/<location>/reasoningEngines/<id>`
 *   for the Agent Engine memory bank.
 *
 * `rag://` selects Vertex AI RAG memory in adk-python. adk-js has no RAG memory
 * service, so it is rejected like any other unsupported scheme.
 *
 * @param uri The memory service URI.
 * @returns The memory service the URI names.
 * @throws when the URI names a service this package does not implement.
 */
export function getMemoryServiceFromUri(uri: string): BaseMemoryService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryMemoryService();
  }

  if (uri.startsWith(AGENT_ENGINE_PREFIX)) {
    const options = parseAgentEngineOptions(
      uri.slice(AGENT_ENGINE_PREFIX.length),
    );
    if (options) {
      return new VertexAiMemoryBankService(options);
    }
  }

  throw new Error(`Unsupported memory service URI: ${redactUriPassword(uri)}`);
}
