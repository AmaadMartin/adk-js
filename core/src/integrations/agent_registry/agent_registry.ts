/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCapabilities,
  AgentCard,
  AgentSkill,
  TransportProtocol,
} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import {GoogleAuth} from 'google-auth-library';
import {RemoteA2AAgent} from '../../a2a/a2a_remote_agent.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme, GcpAuthProviderScheme} from '../../auth/auth_schemes.js';
import {StreamableHTTPConnectionParams} from '../../tools/mcp/mcp_session_manager.js';
import {mergeTrackingHeaders} from '../../utils/client_labels.js';
import {logger} from '../../utils/logger.js';
import {
  effectiveGoogleapisEndpoint,
  hasDefaultClientCertSource,
  shouldUseMtlsEndpoint,
  useClientCertEffective,
} from '../../utils/mtls_utils.js';
import {AgentRegistrySingleMCPToolset} from './agent_registry_mcp_toolset.js';
import {cleanName, isGoogleApi} from './helpers.js';
import {
  AGENT_REGISTRY_BASE_URL,
  AGENT_REGISTRY_MTLS_BASE_URL,
  AgentInfo,
  AgentSkillMetadata,
  ConnectionUriFilter,
  ConnectionUriResult,
  Endpoint,
  ListAgentsResponse,
  ListBindingsResponse,
  ListEndpointsResponse,
  ListMcpServersResponse,
  MakeRequestOptions,
  McpServer,
  ProtocolType,
  SearchOptions,
} from './types.js';

export * from './agent_registry_mcp_toolset.js';
export * from './helpers.js';
export * from './types.js';

const TRANSPORT_MAPPING: Record<string, TransportProtocol> = {
  'HTTP_JSON': 'HTTP+JSON',
  'JSONRPC': 'JSONRPC',
  'GRPC': 'GRPC',
};

/** Returns the message of a thrown value, whatever its type. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Client for interacting with the Google Cloud Agent Registry service.
 *
 * Unlike a standard REST client library, this class provides higher-level
 * abstractions for ADK integration. It surfaces the agent registry service
 * methods along with helper methods like `getMcpToolset` and
 * `getRemoteA2AAgent` that automatically resolve connection details,
 * manage OAuth authentication schemes, and handle GCP credentials to produce
 * ready-to-use ADK components.
 */
export class AgentRegistry {
  readonly projectId: string;
  readonly location: string;
  /**
   * Base URL every request is built from. It is the mutual-TLS variant when
   * the environment asks for one, and is fixed at construction.
   */
  readonly baseUrl: string;
  private readonly useMtls: boolean;
  private readonly basePath: string;
  private readonly headerProvider?: (
    context: ReadonlyContext,
  ) => Record<string, string>;
  private readonly auth: GoogleAuth;

  constructor(options: {
    projectId?: string | null;
    location?: string | null;
    headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  }) {
    if (!options.projectId || !options.location) {
      throw new Error('project_id and location must be provided');
    }
    this.projectId = options.projectId;
    this.location = options.location;
    this.basePath = `projects/${this.projectId}/locations/${this.location}`;
    this.headerProvider = options.headerProvider;
    this.useMtls = shouldUseMtlsEndpoint(
      useClientCertEffective() && hasDefaultClientCertSource(),
    );
    this.baseUrl = this.useMtls
      ? AGENT_REGISTRY_MTLS_BASE_URL
      : AGENT_REGISTRY_BASE_URL;

    // Set up Google Application Default Credentials (ADC) with core cloud platform scopes
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  /**
   * Resolves default Google Cloud credentials and returns standard headers.
   * Automatically caches, fetches, and handles refreshing expired OAuth tokens.
   * Injects the billing/quota project identifier `x-goog-user-project` if present.
   */
  async getAuthHeaders(): Promise<Record<string, string>> {
    let client: Awaited<ReturnType<GoogleAuth['getClient']>>;
    try {
      client = await this.auth.getClient();
    } catch (err: unknown) {
      throw new Error(
        `Failed to get default Google Cloud credentials: ${messageOf(err)}`,
      );
    }

    try {
      const headers = await client.getRequestHeaders(
        'https://agentregistry.googleapis.com',
      );
      const authHeaders: Record<string, string> = {};
      const rawHeaders = headers as unknown as Record<string, string>;
      const authKey = Object.keys(rawHeaders).find(
        (k) => k.toLowerCase() === 'authorization',
      );
      let token = authKey ? rawHeaders[authKey] : undefined;

      // Fallback directly to the populated credentials object if headers are empty
      if (
        !token &&
        client.credentials &&
        (client.credentials as {access_token?: string}).access_token
      ) {
        token = `Bearer ${(client.credentials as {access_token?: string}).access_token}`;
      }

      if (token) {
        authHeaders['Authorization'] = token;
      }
      authHeaders['Content-Type'] = 'application/json';

      // Inject quota project ID for usage and billing tracking
      const quotaProjectId =
        (client as unknown as {quotaProjectId?: string}).quotaProjectId ||
        (this.auth as unknown as {quotaProjectId?: string}).quotaProjectId;
      if (quotaProjectId) {
        authHeaders['x-goog-user-project'] = quotaProjectId;
      }
      return authHeaders;
    } catch (err: unknown) {
      throw new Error(
        `Failed to refresh Google Cloud credentials: ${messageOf(err)}`,
      );
    }
  }

  /**
   * Helper function to execute HTTP requests against the Agent Registry API.
   * Handles path resolution, search query params compilation, and auth headers
   * fetching. A `POST` sends `options.body` as JSON and ignores `params`.
   */
  async makeRequest<T = unknown>(
    path: string,
    params?: Record<string, string>,
    options?: MakeRequestOptions,
  ): Promise<T> {
    let url: string;
    // Support absolute resource paths (starting with projects/) or relative paths (resolved inside base path)
    if (path.startsWith('projects/')) {
      url = `${this.baseUrl}/${path}`;
    } else {
      url = `${this.baseUrl}/${this.basePath}/${path}`;
    }

    const method = options?.method ?? 'GET';
    if (method === 'GET' && params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    try {
      const authHeaders = await this.getAuthHeaders();
      const quotaProjectId =
        authHeaders['x-goog-user-project'] ?? this.projectId;
      const headers = mergeTrackingHeaders({
        ...authHeaders,
        'x-goog-user-project': quotaProjectId,
      });
      const res = await fetch(url, {
        method,
        headers,
        ...(method === 'POST'
          ? {body: JSON.stringify(options?.body ?? {})}
          : {}),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `API request failed with status ${res.status}: ${text}`,
        );
      }
      return (await res.json()) as T;
    } catch (err: unknown) {
      const msg = messageOf(err);
      if (msg.includes('API request failed')) {
        throw err;
      }
      throw new Error(`API request failed: ${msg}`);
    }
  }

  /**
   * Executes a `:search` request for one resource type.
   *
   * `JSON.stringify` drops an undefined-valued key, so only the options the
   * caller supplied reach the request body and the service applies its own
   * default for every other field.
   */
  private async search<T>(
    resourceType: string,
    options: SearchOptions,
  ): Promise<T> {
    const {filterStr: filter, ...rest} = options;
    return this.makeRequest<T>(`${resourceType}:search`, undefined, {
      method: 'POST',
      body: {...rest, filter},
    });
  }

  /**
   * Parses connection interfaces list from registry metadata and returns the first match
   * corresponding to requested protocol types and binding options.
   */
  getConnectionUri(
    resourceDetails: {
      interfaces?: Array<{url?: string; protocolBinding?: string}>;
      protocols?: Array<{
        type?: ProtocolType;
        protocolVersion?: string;
        interfaces?: Array<{url?: string; protocolBinding?: string}>;
      }>;
    },
    filters?: ConnectionUriFilter,
  ): ConnectionUriResult {
    const protocols: Array<{
      type?: ProtocolType;
      protocolVersion?: string;
      interfaces?: Array<{url?: string; protocolBinding?: string}>;
    }> = [];
    if (resourceDetails.protocols) {
      protocols.push(...resourceDetails.protocols);
    }
    if (resourceDetails.interfaces) {
      protocols.push({interfaces: resourceDetails.interfaces});
    }

    for (const p of protocols) {
      if (filters?.protocolType && p.type !== filters.protocolType) {
        continue;
      }
      const protocolVersion = p.protocolVersion;
      const interfaces = p.interfaces || [];
      for (const i of interfaces) {
        const mappedBinding = i.protocolBinding
          ? TRANSPORT_MAPPING[i.protocolBinding]
          : undefined;
        if (
          filters?.protocolBinding &&
          mappedBinding !== filters.protocolBinding
        ) {
          continue;
        }
        if (i.url) {
          const url = this.useMtls ? effectiveGoogleapisEndpoint(i.url) : i.url;
          return {url, protocolVersion, protocolBinding: mappedBinding};
        }
      }
    }

    return {};
  }

  /**
   * Resolves the auth scheme a registered resource is bound to.
   *
   * @param resourceId Stable identifier of the resource, for example an
   *     `agentId` or an `mcpServerId`, matched against the binding targets.
   * @param resourceName Resource name, only used for logging.
   * @param continueUri Continue URI that overrides the auth provider's own.
   * @return The scheme for the bound auth provider, or `undefined` when the
   *     resource is bound to none or the bindings could not be read.
   */
  private async resolveAuthProviderScheme(
    resourceId: string | undefined,
    resourceName: string,
    continueUri?: string,
  ): Promise<GcpAuthProviderScheme | undefined> {
    if (!resourceId) {
      return undefined;
    }
    try {
      const bindingsData =
        await this.makeRequest<ListBindingsResponse>('bindings');
      for (const b of bindingsData.bindings || []) {
        const targetId = b.target?.identifier || '';
        if (!targetId.endsWith(resourceId)) {
          continue;
        }
        const authProvider = b.authProviderBinding?.authProvider;
        if (authProvider) {
          return {
            type: 'gcpAuthProviderScheme',
            name: authProvider,
            continueUri,
          };
        }
      }
    } catch (err: unknown) {
      logger.warn(
        `Failed to fetch bindings for ${resourceName}: ${messageOf(err)}`,
      );
    }
    return undefined;
  }

  // --- MCP Server Methods ---

  /** Searches registered MCP Servers. */
  async searchMcpServers(
    options?: SearchOptions,
  ): Promise<ListMcpServersResponse> {
    return this.search<ListMcpServersResponse>('mcpServers', options ?? {});
  }

  async listMcpServers(options?: {
    filterStr?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListMcpServersResponse> {
    const params: Record<string, string> = {};
    if (options?.filterStr) {
      params['filter'] = options.filterStr;
    }
    if (options?.pageSize) {
      params['pageSize'] = String(options.pageSize);
    }
    if (options?.pageToken) {
      params['pageToken'] = options.pageToken;
    }
    return this.makeRequest<ListMcpServersResponse>('mcpServers', params);
  }

  async getMcpServer(name: string): Promise<McpServer> {
    return this.makeRequest<McpServer>(name);
  }

  async getMcpToolset(
    mcpServerName: string,
    options?: {
      authScheme?: AuthScheme;
      authCredential?: AuthCredential;
      continueUri?: string;
    },
  ): Promise<AgentRegistrySingleMCPToolset> {
    const serverDetails = await this.getMcpServer(mcpServerName);
    const name = cleanName(serverDetails.displayName || mcpServerName);
    const mcpServerId = serverDetails.mcpServerId;

    let endpointUri = this.getConnectionUri(serverDetails, {
      protocolBinding: 'JSONRPC',
    }).url;

    if (!endpointUri) {
      endpointUri = this.getConnectionUri(serverDetails, {
        protocolBinding: 'HTTP+JSON',
      }).url;
    }

    if (!endpointUri) {
      throw new Error(
        `MCP Server endpoint URI not found for: ${mcpServerName}`,
      );
    }

    const authScheme =
      options?.authScheme ??
      (await this.resolveAuthProviderScheme(
        mcpServerId,
        `MCP Server ${mcpServerName}`,
        options?.continueUri,
      ));

    const connectionParams: StreamableHTTPConnectionParams = {
      type: 'StreamableHTTPConnectionParams',
      url: endpointUri,
    };

    const combinedHeaderProvider = async (context?: ReadonlyContext) => {
      const headers: Record<string, string> = {};
      if (
        !authScheme &&
        !options?.authCredential &&
        isGoogleApi(endpointUri!)
      ) {
        Object.assign(headers, await this.getAuthHeaders());
      }
      if (this.headerProvider && context) {
        Object.assign(headers, this.headerProvider(context));
      }
      return headers;
    };

    return new AgentRegistrySingleMCPToolset({
      destinationResourceId: mcpServerId,
      connectionParams,
      prefix: name,
      headerProvider: combinedHeaderProvider,
      authScheme,
      authCredential: options?.authCredential,
    });
  }

  // --- Endpoint Methods ---

  async listEndpoints(options?: {
    filterStr?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListEndpointsResponse> {
    const params: Record<string, string> = {};
    if (options?.filterStr) {
      params['filter'] = options.filterStr;
    }
    if (options?.pageSize) {
      params['pageSize'] = String(options.pageSize);
    }
    if (options?.pageToken) {
      params['pageToken'] = options.pageToken;
    }
    return this.makeRequest<ListEndpointsResponse>('endpoints', params);
  }

  async getEndpoint(name: string): Promise<Endpoint> {
    return this.makeRequest<Endpoint>(name);
  }

  async getModelName(endpointName: string): Promise<string> {
    const endpointDetails = await this.getEndpoint(endpointName);
    const {url} = this.getConnectionUri(endpointDetails);
    if (!url) {
      throw new Error(`Connection URI not found for endpoint: ${endpointName}`);
    }

    const uri = url.replace(/:\w+$/, '');
    if (uri.startsWith('projects/')) {
      return uri;
    }

    const match = uri.match(/(projects\/.+)/);
    if (match) {
      return match[1];
    }
    return uri;
  }

  // --- Agent Methods ---

  /** Searches registered A2A Agents. */
  async searchAgents(options?: SearchOptions): Promise<ListAgentsResponse> {
    return this.search<ListAgentsResponse>('agents', options ?? {});
  }

  async listAgents(options?: {
    filterStr?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListAgentsResponse> {
    const params: Record<string, string> = {};
    if (options?.filterStr) {
      params['filter'] = options.filterStr;
    }
    if (options?.pageSize) {
      params['pageSize'] = String(options.pageSize);
    }
    if (options?.pageToken) {
      params['pageToken'] = options.pageToken;
    }
    return this.makeRequest<ListAgentsResponse>('agents', params);
  }

  async getAgentInfo(name: string): Promise<AgentInfo> {
    return this.makeRequest<AgentInfo>(name);
  }

  /**
   * Creates a {@link RemoteA2AAgent} for a registered A2A Agent.
   *
   * When `authScheme` is omitted, it is resolved from the agent's auth provider
   * binding. The returned agent presents `authCredential` on every request it
   * makes. An auth provider binding names a provider and carries no credential
   * of its own, so pass one to authenticate those calls.
   *
   * @param agentName Resource name of the A2A Agent.
   * @param options.authScheme Scheme to use as is, skipping the binding lookup.
   * @param options.authCredential Credential for the scheme.
   * @param options.continueUri Continue URI that overrides the auth provider's
   *     own.
   */
  async getRemoteA2AAgent(
    agentName: string,
    options?: {
      client?: Client;
      clientFactory?: ClientFactory;
      authScheme?: AuthScheme;
      authCredential?: AuthCredential;
      continueUri?: string;
    },
  ): Promise<RemoteA2AAgent> {
    const agentInfo = await this.getAgentInfo(agentName);

    const authScheme =
      options?.authScheme ??
      (await this.resolveAuthProviderScheme(
        agentInfo.agentId,
        `Agent ${agentName}`,
        options?.continueUri,
      ));
    const authCredential = options?.authCredential;

    // Try to use the full agent card if available
    const card = agentInfo.card || {};
    const cardContent = card.content;
    if (card.type === 'A2A_AGENT_CARD' && cardContent) {
      const agentCard: AgentCard = cardContent;
      const name = cleanName(agentCard.name);

      return new RemoteA2AAgent({
        name,
        agentCard,
        description: agentCard.description,
        client: options?.client,
        clientFactory: options?.clientFactory,
        authScheme,
        authCredential,
      });
    }

    const name = cleanName(agentInfo.displayName || agentName);
    const description = agentInfo.description || '';
    const version = agentInfo.version || '';

    const {url, protocolVersion, protocolBinding} = this.getConnectionUri(
      agentInfo,
      {
        protocolType: ProtocolType.A2A_AGENT,
      },
    );

    if (!url) {
      throw new Error(`A2A connection URI not found for Agent: ${agentName}`);
    }

    const skills: AgentSkill[] = (agentInfo.skills || []).map(
      (s: AgentSkillMetadata) => ({
        id: s.id!,
        name: s.name!,
        description: s.description || '',
        tags: s.tags || [],
        examples: (s.examples as string[]) || [],
      }),
    );

    const agentCard: AgentCard = {
      name,
      description,
      version,
      preferredTransport: protocolBinding || 'HTTP+JSON',
      protocolVersion: protocolVersion || '0.3.0',
      url,
      skills,
      capabilities: {
        streaming: false,
      } as AgentCapabilities,
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    };

    return new RemoteA2AAgent({
      name,
      agentCard,
      description,
      client: options?.client,
      clientFactory: options?.clientFactory,
      authScheme,
      authCredential,
    });
  }
}
