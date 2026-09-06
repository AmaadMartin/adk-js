/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, TransportProtocol} from '@a2a-js/sdk';

export const AGENT_REGISTRY_BASE_URL =
  'https://agentregistry.googleapis.com/v1alpha';

/**
 * Mutual-TLS variant of {@link AGENT_REGISTRY_BASE_URL}. The two must always
 * name the same API version.
 */
export const AGENT_REGISTRY_MTLS_BASE_URL =
  'https://agentregistry.mtls.googleapis.com/v1alpha';

// Telemetry owns the span-attribute name; re-exported here so the existing
// import path keeps working.
export {GCP_MCP_SERVER_DESTINATION_ID} from '../../telemetry/tracing.js';

/** Search mode accepted by the registry `:search` verbs. */
export type SearchType = 'KEYWORD' | 'SEMANTIC';

/** Options common to `searchAgents` and `searchMcpServers`. */
export interface SearchOptions {
  searchString?: string;
  searchType?: SearchType;
  filterStr?: string;
  orderBy?: string;
  pageSize?: number;
  pageToken?: string;
}

/** Per-request overrides for `AgentRegistry.makeRequest`. */
export interface MakeRequestOptions {
  method?: 'GET' | 'POST';
  /** JSON request body. Sent only for POST. */
  body?: unknown;
}

export enum ProtocolType {
  TYPE_UNSPECIFIED = 'TYPE_UNSPECIFIED',
  A2A_AGENT = 'A2A_AGENT',
  CUSTOM = 'CUSTOM',
}

export interface Interface {
  url?: string;
  protocolBinding?: string;
}

export interface Endpoint {
  name?: string;
  endpointId?: string;
  displayName?: string;
  description?: string;
  interfaces?: Interface[];
  createTime?: string;
  updateTime?: string;
  attributes?: Record<string, unknown>;
}

// Agent Identity owns the scheme; re-exported here so the existing import path
// keeps working.
export type {GcpAuthProviderScheme} from '../agent_identity/gcp_auth_provider_scheme.js';

export interface McpServer {
  name?: string;
  displayName?: string;
  mcpServerId?: string;
  interfaces?: Interface[];
  protocols?: Array<{
    type?: ProtocolType;
    protocolVersion?: string;
    interfaces?: Interface[];
  }>;
  [key: string]: unknown;
}

export interface Binding {
  target?: {
    identifier?: string;
  };
  authProviderBinding?: {
    authProvider?: string;
  };
}

export interface ListBindingsResponse {
  bindings?: Binding[];
}

export interface ListMcpServersResponse {
  mcpServers?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export interface ListEndpointsResponse {
  endpoints?: Array<Endpoint>;
  nextPageToken?: string;
}

export interface ListAgentsResponse {
  agents?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export interface AgentSkillMetadata {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: unknown[];
}

export interface AgentInfo {
  /** Stable identifier of the agent, matched against IAM binding targets. */
  agentId?: string;
  displayName?: string;
  description?: string;
  version?: string;
  card?: {
    type?: string;
    content?: AgentCard;
  };
  interfaces?: Interface[];
  protocols?: Array<{
    type?: ProtocolType;
    protocolVersion?: string;
    interfaces?: Interface[];
  }>;
  skills?: AgentSkillMetadata[];
  [key: string]: unknown;
}

export interface ConnectionUriFilter {
  protocolType?: ProtocolType;
  protocolBinding?: string;
}

export interface ConnectionUriResult {
  url?: string;
  protocolVersion?: string;
  protocolBinding?: TransportProtocol;
}
