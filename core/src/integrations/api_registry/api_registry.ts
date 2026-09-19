/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {StreamableHTTPConnectionParams} from '../../tools/mcp/mcp_session_manager.js';
import {getTrackingHeaders} from '../../utils/client_labels.js';
import {deprecated} from '../../utils/deprecated.js';
import {formatError} from '../../utils/error_utils.js';
import {
  chooseApiEndpoint,
  clientCertsToPresent,
  getWithClientCert,
  MtlsClientCerts,
  TextResponse,
} from '../../utils/mtls_utils.js';
import {AgentRegistrySingleMCPToolset} from '../agent_registry/agent_registry_mcp_toolset.js';
import {isGoogleApi} from '../agent_registry/helpers.js';
import {
  ApiRegistryMcpServer,
  ApiRegistryOptions,
  ApiRegistryToolsetOptions,
  ListApiRegistryMcpServersResponse,
} from './types.js';

export * from './types.js';

const API_REGISTRY_URL = 'https://cloudapiregistry.googleapis.com';
const API_REGISTRY_MTLS_URL = 'https://cloudapiregistry.mtls.googleapis.com';
const API_REGISTRY_API_VERSION = 'v1beta';

/**
 * Includes every registered API, disabled ones too. API Registry no longer
 * supports enabling an API.
 */
const LIST_MCP_SERVERS_FILTER = 'enabled=false';

const DEFAULT_LOCATION = 'global';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const LISTING_REQUEST_TIMEOUT_MS = 60_000;

/** Performs one GET over `fetch`, shaped like {@link getWithClientCert}. */
async function getWithFetch(
  url: string,
  headers: Record<string, string>,
): Promise<TextResponse> {
  const response = await fetch(url, {method: 'GET', headers});
  return {status: response.status, body: await response.text()};
}

/** Prefixes `https://` unless the registered URL already carries a scheme. */
function withHttpScheme(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://')
    ? url
    : `https://${url}`;
}

/**
 * Whether the caller's own credentials may be attached to `url`.
 *
 * A registry entry can name any host, so an access token goes only to a Google
 * API endpoint reached over https. {@link isGoogleApi} tests the host alone and
 * is shared with `AgentRegistry`, so the scheme test lives here rather than
 * there; adk-python's `_is_google_api` requires both.
 */
function isHttpsGoogleApi(url: string): boolean {
  return url.startsWith('https://') && isGoogleApi(url);
}

/**
 * Registry for MCP servers registered in Cloud API Registry.
 *
 * The registry is listed once, when the instance is constructed, and
 * {@link getToolset} hands out one MCP toolset per registered server.
 *
 * @deprecated Use {@link AgentRegistry} instead. It talks to the Agent Registry
 *   service, which supersedes Cloud API Registry.
 */
@deprecated(
  'ApiRegistry is deprecated. Use AgentRegistry from @google/adk instead.',
)
export class ApiRegistry {
  readonly projectId: string;
  readonly location: string;

  private readonly headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
  private readonly auth: GoogleAuth;
  private readonly mcpServers = new Map<string, ApiRegistryMcpServer>();

  /**
   * Resolves once the registry listing is complete, and rejects with the
   * listing failure.
   *
   * adk-python raises from `__init__`; a TypeScript constructor cannot await,
   * so the listing starts here and {@link getToolset} is where it surfaces.
   */
  private readonly listing: Promise<void>;

  constructor(options: ApiRegistryOptions) {
    if (!options.projectId) {
      throw new Error('projectId must be provided');
    }
    this.projectId = options.projectId;
    this.location = options.location || DEFAULT_LOCATION;
    this.headerProvider = options.headerProvider;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});

    this.listing = this.listMcpServers();
    // An instance nobody queries must not raise an unhandled rejection; the
    // failure is still delivered to whoever awaits `listing` in getToolset.
    this.listing.catch(() => {});
  }

  /**
   * Returns the MCP toolset for one registered server.
   *
   * @param mcpServerName - Name of the registered MCP server.
   * @param options - Tool selection and naming for the returned toolset.
   * @throws If the registry listing failed, or the server is not registered,
   *   or it has no registered URL.
   */
  async getToolset(
    mcpServerName: string,
    options?: ApiRegistryToolsetOptions,
  ): Promise<AgentRegistrySingleMCPToolset> {
    await this.listing;

    const server = this.mcpServers.get(mcpServerName);
    if (!server) {
      throw new Error(`MCP server ${mcpServerName} not found in API Registry.`);
    }
    const registeredUrl = server.urls?.[0];
    if (!registeredUrl) {
      throw new Error(`MCP server ${mcpServerName} has no URLs.`);
    }

    const url = withHttpScheme(registeredUrl);
    const connectionParams: StreamableHTTPConnectionParams = {
      type: 'StreamableHTTPConnectionParams',
      url,
    };
    const attachCredentials = isHttpsGoogleApi(url);

    return new AgentRegistrySingleMCPToolset({
      connectionParams,
      toolFilter: options?.toolFilter,
      prefix: options?.toolNamePrefix,
      headerProvider: async (context?: ReadonlyContext) => {
        const headers: Record<string, string> = attachCredentials
          ? await this.getAuthHeaders()
          : {};
        if (this.headerProvider) {
          Object.assign(headers, await this.headerProvider(context));
        }
        return headers;
      },
    });
  }

  /**
   * Resolves Application Default Credentials into request headers.
   *
   * The quota project is sent as `x-goog-user-project` when the credentials
   * carry one.
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const requestHeaders = await client.getRequestHeaders(API_REGISTRY_URL);

    const headers: Record<string, string> = {};
    const authorization = requestHeaders.get('authorization');
    if (authorization) {
      headers['Authorization'] = authorization;
    }
    if (client.quotaProjectId) {
      headers['x-goog-user-project'] = client.quotaProjectId;
    }
    return headers;
  }

  /** Reads every page of the MCP server listing into {@link mcpServers}. */
  private async listMcpServers(): Promise<void> {
    const certs = await clientCertsToPresent();
    const baseUrl = chooseApiEndpoint(
      certs,
      API_REGISTRY_URL,
      API_REGISTRY_MTLS_URL,
    );
    const url = `${baseUrl}/${API_REGISTRY_API_VERSION}/projects/${this.projectId}/locations/${this.location}/mcpServers`;

    // Resolved outside the try so a credential failure is not reported as a
    // listing failure.
    const headers = {
      ...getTrackingHeaders(),
      'Content-Type': 'application/json',
      ...(await this.getAuthHeaders()),
    };

    try {
      let pageToken: string | undefined;
      do {
        const page = await fetchPage(url, headers, certs, pageToken);
        for (const server of page.mcpServers ?? []) {
          if (server.name) {
            this.mcpServers.set(server.name, server);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e: unknown) {
      throw new Error(
        `Error fetching MCP servers from API Registry: ${formatError(e)}`,
      );
    }
  }
}

/** Reads one page of the MCP server listing. */
async function fetchPage(
  url: string,
  headers: Record<string, string>,
  certs: MtlsClientCerts | undefined,
  pageToken: string | undefined,
): Promise<ListApiRegistryMcpServersResponse> {
  const params = new URLSearchParams({filter: LIST_MCP_SERVERS_FILTER});
  if (pageToken) {
    params.set('pageToken', pageToken);
  }
  const pageUrl = `${url}?${params.toString()}`;

  const {status, body} = certs
    ? await getWithClientCert(
        pageUrl,
        headers,
        certs,
        LISTING_REQUEST_TIMEOUT_MS,
      )
    : await getWithFetch(pageUrl, headers);

  if (status < 200 || status >= 300) {
    throw new Error(`GET ${pageUrl} returned status ${status}: ${body}`);
  }
  return JSON.parse(body) as ListApiRegistryMcpServersResponse;
}
