/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {ToolPredicate} from '../../tools/base_toolset.js';
import {StreamableHTTPConnectionParams} from '../../tools/mcp/mcp_session_manager.js';
import {getTrackingHeaders} from '../../utils/client_labels.js';
import {deprecated} from '../../utils/deprecated.js';
import {formatError} from '../../utils/error_utils.js';
import {resolveAuthHeaders} from '../../utils/google_auth_headers.js';
import {
  getWithClientCert,
  HttpGetResult,
  loadDefaultClientCerts,
  MtlsClientCerts,
  MtlsEndpoint,
  mtlsEndpointSetting,
  useClientCertEffective,
} from '../../utils/mtls_utils.js';
import {AgentRegistrySingleMCPToolset} from '../agent_registry/agent_registry_mcp_toolset.js';

/** Base URL of the API Registry service. */
const API_REGISTRY_URL = 'https://cloudapiregistry.googleapis.com';

/** Base URL of the mutual-TLS API Registry service. */
const API_REGISTRY_MTLS_URL = 'https://cloudapiregistry.mtls.googleapis.com';

const API_REGISTRY_API_VERSION = 'v1beta';

/** Includes disabled servers: API Registry no longer supports enabling APIs. */
const LIST_MCP_SERVERS_FILTER = 'enabled=false';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_LOCATION = 'global';

/** Budget for one listing page, on either transport. */
const LISTING_REQUEST_TIMEOUT_MS = 60_000;

/** An MCP server as the API Registry v1beta listing returns it. */
export interface ApiRegistryMcpServer {
  name?: string;
  urls?: string[];
}

/** One page of the API Registry v1beta MCP server listing. */
export interface ListApiRegistryMcpServersResponse {
  mcpServers?: ApiRegistryMcpServer[];
  nextPageToken?: string;
}

/** Options accepted by the {@link ApiRegistry} constructor. */
export interface ApiRegistryOptions {
  /** Google Cloud project that owns the API Registry resources. */
  projectId: string;
  /** API Registry location. Defaults to `global`. */
  location?: string;
  /**
   * Supplies extra headers for the MCP server connection. Called before each
   * connection, so a value it returns may be short-lived. It is not called for
   * the registry listing request.
   */
  headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

/** Options accepted by {@link ApiRegistry.getToolset}. */
export interface ApiRegistryToolsetOptions {
  /** Selects which of the server's tools are exposed. Defaults to all. */
  toolFilter?: ToolPredicate | string[];
  /** Prefix prepended to every tool name the toolset returns. */
  toolNamePrefix?: string;
}

/** Returns the API Registry base URL for the current mTLS configuration. */
function apiRegistryBaseUrl(hasClientCert: boolean): string {
  const setting = mtlsEndpointSetting();
  const useMtls =
    setting === MtlsEndpoint.ALWAYS ||
    (setting === MtlsEndpoint.AUTO && hasClientCert);
  return useMtls ? API_REGISTRY_MTLS_URL : API_REGISTRY_URL;
}

/** Performs the listing GET, presenting a client certificate when there is one. */
async function getListingPage(
  url: string,
  headers: Record<string, string>,
  certs?: MtlsClientCerts,
): Promise<HttpGetResult> {
  if (certs) {
    return getWithClientCert(url, headers, certs, LISTING_REQUEST_TIMEOUT_MS);
  }
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(LISTING_REQUEST_TIMEOUT_MS),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  };
}

/**
 * Reads every page of the MCP server listing and indexes the servers by name.
 *
 * A server without a name is skipped, so it cannot evict a named sibling. A
 * name repeated across pages keeps its last occurrence, matching adk-python.
 *
 * @param baseUrl Base URL of the API Registry service.
 * @param headers Headers sent with every page request.
 * @param certs Client certificate to present, if there is one.
 */
export async function listApiRegistryMcpServers(
  baseUrl: string,
  projectId: string,
  location: string,
  headers: Record<string, string>,
  certs?: MtlsClientCerts,
): Promise<Map<string, ApiRegistryMcpServer>> {
  const url = `${baseUrl}/${API_REGISTRY_API_VERSION}/projects/${projectId}/locations/${location}/mcpServers`;
  const servers = new Map<string, ApiRegistryMcpServer>();
  try {
    let pageToken: string | undefined;
    for (;;) {
      const query = new URLSearchParams({filter: LIST_MCP_SERVERS_FILTER});
      if (pageToken) {
        query.set('pageToken', pageToken);
      }
      const response = await getListingPage(`${url}?${query}`, headers, certs);
      if (!response.ok) {
        throw new Error(`request failed with status ${response.status}`);
      }
      const page = JSON.parse(
        response.body,
      ) as ListApiRegistryMcpServersResponse;
      for (const server of page.mcpServers ?? []) {
        if (server.name) {
          servers.set(server.name, server);
        }
      }
      pageToken = page.nextPageToken;
      if (!pageToken) {
        return servers;
      }
    }
  } catch (e: unknown) {
    throw new Error(
      `Error fetching MCP servers from API Registry: ${formatError(e)}`,
    );
  }
}

/**
 * Registry of the MCP servers registered in Google Cloud API Registry.
 *
 * @deprecated Use `AgentRegistry` instead, which reaches the newer Agent
 * Registry service. This class is kept so that code ported from adk-python
 * finds the same class name.
 */
@deprecated(
  'ApiRegistry is deprecated. Use AgentRegistry from @google/adk instead.',
)
export class ApiRegistry {
  readonly projectId: string;
  readonly location: string;
  private readonly auth: GoogleAuth;
  private readonly headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
  private readonly mcpServers: Promise<Map<string, ApiRegistryMcpServer>>;

  constructor(options: ApiRegistryOptions) {
    if (!options.projectId) {
      throw new Error('projectId must be provided');
    }
    this.projectId = options.projectId;
    this.location = options.location || DEFAULT_LOCATION;
    this.headerProvider = options.headerProvider;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});

    // adk-python lists the servers from its constructor and raises there. A
    // TypeScript constructor cannot await, so the listing starts here and its
    // failure surfaces at the first `getToolset` call. The handler below keeps
    // an instance nobody queries from raising an unhandled rejection.
    this.mcpServers = this.listMcpServers();
    this.mcpServers.catch(() => {});
  }

  private async listMcpServers(): Promise<Map<string, ApiRegistryMcpServer>> {
    const certs = useClientCertEffective()
      ? await loadDefaultClientCerts()
      : undefined;
    const baseUrl = apiRegistryBaseUrl(certs !== undefined);
    // Resolved outside listApiRegistryMcpServers so that a credentials failure
    // propagates unwrapped, as it does in adk-python.
    const headers = {
      ...getTrackingHeaders(),
      'Content-Type': 'application/json',
      ...(await resolveAuthHeaders(this.auth, baseUrl)),
    };
    return listApiRegistryMcpServers(
      baseUrl,
      this.projectId,
      this.location,
      headers,
      certs,
    );
  }

  /**
   * Returns a toolset for one registered MCP server.
   *
   * @param mcpServerName Server name, exactly as the registry reports it.
   * @param options Tool selection and naming.
   * @throws If the listing failed, if no server carries that name, or if the
   *   server has no registered URL.
   */
  async getToolset(
    mcpServerName: string,
    options?: ApiRegistryToolsetOptions,
  ): Promise<AgentRegistrySingleMCPToolset> {
    const server = (await this.mcpServers).get(mcpServerName);
    if (!server) {
      throw new Error(`MCP server ${mcpServerName} not found in API Registry.`);
    }
    const registeredUrl = server.urls?.[0];
    if (!registeredUrl) {
      throw new Error(`MCP server ${mcpServerName} has no URLs.`);
    }
    const url = /^https?:\/\//.test(registeredUrl)
      ? registeredUrl
      : `https://${registeredUrl}`;
    // A cleartext connection would put a cloud-platform bearer token on the
    // wire in plain text, so the credentials are withheld from one.
    const isEncrypted = url.startsWith('https://');

    const headerProvider = async (context?: ReadonlyContext) => {
      const headers: Record<string, string> = {};
      if (isEncrypted) {
        Object.assign(headers, await resolveAuthHeaders(this.auth, url));
      }
      if (this.headerProvider) {
        Object.assign(headers, await this.headerProvider(context));
      }
      return headers;
    };

    const connectionParams: StreamableHTTPConnectionParams = {
      type: 'StreamableHTTPConnectionParams',
      url,
    };
    return new AgentRegistrySingleMCPToolset({
      connectionParams,
      prefix: options?.toolNamePrefix,
      toolFilter: options?.toolFilter,
      headerProvider,
    });
  }
}
