/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {ToolPredicate} from '../../tools/base_toolset.js';
import {MCPToolset} from '../../tools/mcp/mcp_toolset.js';
import {logger} from '../../utils/logger.js';

const API_REGISTRY_URL = 'https://cloudapiregistry.googleapis.com';
const API_REGISTRY_API_VERSION = 'v1beta';
/** API Registry no longer supports enabling APIs, so disabled ones are listed too. */
const LIST_MCP_SERVERS_FILTER = 'enabled=false';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEPRECATION_MESSAGE =
  'ApiRegistry is deprecated. Use AgentRegistry from @google/adk instead.';

interface ApiRegistryMcpServer {
  name?: string;
  urls?: string[];
}

interface ListApiRegistryMcpServersResponse {
  mcpServers?: ApiRegistryMcpServer[];
  nextPageToken?: string;
}

/** Options accepted by the {@link ApiRegistry} constructor. */
export interface ApiRegistryOptions {
  /** Google Cloud project that owns the API Registry resources. */
  projectId: string;
  /** API Registry location. Defaults to 'global'. */
  location?: string;
}

/** Options accepted by {@link ApiRegistry.getToolset}. */
export interface ApiRegistryToolsetOptions {
  /** Selects which of the server's tools are exposed. Defaults to all of them. */
  toolFilter?: ToolPredicate | string[];
  /** Prefix prepended to the name of every tool the toolset returns. */
  toolNamePrefix?: string;
}

/** Prepends `https://` unless the URL already carries a scheme. */
function toAbsoluteUrl(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://')
    ? url
    : `https://${url}`;
}

/**
 * Registry that provides {@link MCPToolset}s for MCP servers registered in the
 * Google Cloud API Registry.
 *
 * @deprecated Use `AgentRegistry` instead.
 */
export class ApiRegistry {
  readonly projectId: string;
  readonly location: string;
  private readonly listUrl: string;
  private readonly auth: GoogleAuth;
  private serversPromise?: Promise<Map<string, ApiRegistryMcpServer>>;

  constructor(options: ApiRegistryOptions) {
    if (!options.projectId) {
      throw new Error('project_id must be provided');
    }
    logger.warn(DEPRECATION_MESSAGE);
    this.projectId = options.projectId;
    this.location = options.location ?? 'global';
    this.listUrl =
      `${API_REGISTRY_URL}/${API_REGISTRY_API_VERSION}` +
      `/projects/${this.projectId}/locations/${this.location}/mcpServers`;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  /**
   * Returns a toolset for the named MCP server, resolving its URL from the API
   * Registry and authorizing the connection with Application Default
   * Credentials.
   *
   * @param mcpServerName Name of the MCP server as registered in API Registry.
   * @param options Optional tool filtering and name prefixing.
   * @return A toolset connected to that MCP server.
   * @throws If the listing cannot be fetched, the server is unknown, or the
   *     server has no URL registered.
   */
  async getToolset(
    mcpServerName: string,
    options?: ApiRegistryToolsetOptions,
  ): Promise<MCPToolset> {
    const servers = await this.loadMcpServers();
    const server = servers.get(mcpServerName);
    if (!server) {
      throw new Error(`MCP server ${mcpServerName} not found in API Registry.`);
    }
    const url = server.urls?.[0];
    if (!url) {
      throw new Error(`MCP server ${mcpServerName} has no URLs.`);
    }

    const headers = await this.getAuthHeaders();
    return new MCPToolset(
      {
        type: 'StreamableHTTPConnectionParams',
        url: toAbsoluteUrl(url),
        transportOptions: {requestInit: {headers}},
      },
      options?.toolFilter,
      options?.toolNamePrefix,
    );
  }

  /**
   * Returns the registry listing, fetching it at most once per instance.
   *
   * The memo is cleared on failure so a transient network error does not
   * permanently poison the instance, and so no rejected promise is retained.
   */
  private loadMcpServers(): Promise<Map<string, ApiRegistryMcpServer>> {
    this.serversPromise ??= this.fetchMcpServers().catch((err: unknown) => {
      this.serversPromise = undefined;
      throw err;
    });
    return this.serversPromise;
  }

  /** Fetches every page of the MCP server listing, keyed by server name. */
  private async fetchMcpServers(): Promise<Map<string, ApiRegistryMcpServer>> {
    const servers = new Map<string, ApiRegistryMcpServer>();
    try {
      const headers = {
        ...(await this.getAuthHeaders()),
        'Content-Type': 'application/json',
      };
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({filter: LIST_MCP_SERVERS_FILTER});
        if (pageToken) {
          params.set('pageToken', pageToken);
        }
        const res = await fetch(`${this.listUrl}?${params.toString()}`, {
          method: 'GET',
          headers,
        });
        if (!res.ok) {
          throw new Error(
            `request failed with status ${res.status}: ${await res.text()}`,
          );
        }
        const data = (await res.json()) as ListApiRegistryMcpServersResponse;
        for (const server of data.mcpServers ?? []) {
          if (server.name) {
            servers.set(server.name, server);
          }
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Error fetching MCP servers from API Registry: ${msg}`);
    }
    return servers;
  }

  /**
   * Returns the authorization headers used for the MCP connection. The listing
   * request adds `Content-Type` on top of these; the MCP connection must not
   * carry it.
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const {token} = await client.getAccessToken();
    if (!token) {
      throw new Error(
        'Failed to obtain Google Cloud access token for API Registry.',
      );
    }
    const headers: Record<string, string> = {Authorization: `Bearer ${token}`};
    if (client.quotaProjectId) {
      headers['x-goog-user-project'] = client.quotaProjectId;
    }
    return headers;
  }
}
