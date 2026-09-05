/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {ToolPredicate} from '../../tools/base_toolset.js';
import {logger} from '../../utils/logger.js';
import {
  clientCertsToPresent,
  getWithClientCert,
  MtlsClientCerts,
} from '../../utils/mtls_utils.js';
import {AgentRegistrySingleMCPToolset} from '../agent_registry/agent_registry_mcp_toolset.js';
import {isGoogleApi} from '../agent_registry/helpers.js';

/** The default Cloud API Registry host. */
const API_REGISTRY_URL = 'https://cloudapiregistry.googleapis.com';
/** The mutual-TLS Cloud API Registry host. */
const API_REGISTRY_MTLS_URL = 'https://cloudapiregistry.mtls.googleapis.com';
const API_REGISTRY_API_VERSION = 'v1beta';
/** API Registry no longer supports enabling APIs, so disabled ones are listed too. */
const LIST_MCP_SERVERS_FILTER = 'enabled=false';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEPRECATION_MESSAGE =
  'ApiRegistry is deprecated. Use AgentRegistry from @google/adk instead.';

/** How long a listing request that presents a client certificate may take. */
const CLIENT_CERT_REQUEST_TIMEOUT_MS = 60_000;

/** The environment variable that selects the registry host. */
const USE_MTLS_ENDPOINT_ENV = 'GOOGLE_API_USE_MTLS_ENDPOINT';

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
  /**
   * Supplies extra headers for the MCP server calls. It is called before each
   * connection, so a header it returns may carry a value that expires.
   *
   * These headers are not sent on the registry listing request.
   */
  headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
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
 * Reports whether `url` is a Google API host reached over TLS.
 *
 * Credentials are attached only to such a URL. {@link isGoogleApi} on its own
 * accepts `http://…googleapis.com`, which would put a cloud-platform bearer
 * token on the wire in cleartext.
 */
function isHttpsGoogleApi(url: string): boolean {
  return url.startsWith('https://') && isGoogleApi(url);
}

/**
 * Chooses the registry host.
 *
 * `always` picks the mutual-TLS host and `never` picks the default one. Every
 * other setting, including an unset or unrecognised one, means `auto`: the
 * mutual-TLS host is used only when a client certificate is available to
 * present on that connection.
 *
 * @param hasClientCert Whether a client certificate was loaded.
 */
function apiRegistryUrl(hasClientCert: boolean): string {
  const setting = (process.env[USE_MTLS_ENDPOINT_ENV] ?? '').toLowerCase();
  if (setting === 'always') {
    return API_REGISTRY_MTLS_URL;
  }
  if (setting === 'never') {
    return API_REGISTRY_URL;
  }
  return hasClientCert ? API_REGISTRY_MTLS_URL : API_REGISTRY_URL;
}

/**
 * Reads one page of the listing.
 *
 * `globalThis.fetch` cannot present a client certificate in Node, so a request
 * that has to present one goes through {@link getWithClientCert} instead.
 *
 * @param url The absolute URL to request.
 * @param headers The request headers.
 * @param certs The certificate to present, when the environment asks for one.
 * @return The response body, as text.
 * @throws If the response status is outside the 2xx range.
 */
async function readListingPage(
  url: string,
  headers: Record<string, string>,
  certs?: MtlsClientCerts,
): Promise<string> {
  if (certs) {
    const {status, body} = await getWithClientCert(
      url,
      headers,
      certs,
      CLIENT_CERT_REQUEST_TIMEOUT_MS,
    );
    if (status < 200 || status > 299) {
      throw new Error(`request failed with status ${status}: ${body}`);
    }
    return body;
  }
  const res = await fetch(url, {method: 'GET', headers});
  if (!res.ok) {
    throw new Error(
      `request failed with status ${res.status}: ${await res.text()}`,
    );
  }
  return res.text();
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
  private readonly auth: GoogleAuth;
  private readonly headerProvider?: ApiRegistryOptions['headerProvider'];
  private serversPromise?: Promise<Map<string, ApiRegistryMcpServer>>;

  constructor(options: ApiRegistryOptions) {
    if (!options.projectId) {
      throw new Error('project_id must be provided');
    }
    logger.warn(DEPRECATION_MESSAGE);
    this.projectId = options.projectId;
    this.location = options.location ?? 'global';
    this.headerProvider = options.headerProvider;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  /**
   * Returns a toolset for the named MCP server, resolving its URL from the API
   * Registry and authorizing the connection with Application Default
   * Credentials.
   *
   * The credentials are resolved before each connection rather than baked into
   * the toolset, so a long-lived agent keeps working after the first access
   * token expires.
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
  ): Promise<AgentRegistrySingleMCPToolset> {
    const servers = await this.loadMcpServers();
    const server = servers.get(mcpServerName);
    if (!server) {
      throw new Error(`MCP server ${mcpServerName} not found in API Registry.`);
    }
    const url = server.urls?.[0];
    if (!url) {
      throw new Error(`MCP server ${mcpServerName} has no URLs.`);
    }
    const serverUrl = toAbsoluteUrl(url);

    return new AgentRegistrySingleMCPToolset({
      connectionParams: {
        type: 'StreamableHTTPConnectionParams',
        url: serverUrl,
      },
      toolFilter: options?.toolFilter,
      prefix: options?.toolNamePrefix,
      headerProvider: (context?: ReadonlyContext) =>
        this.mcpHeaders(serverUrl, context),
    });
  }

  /**
   * Builds the headers for one MCP connection.
   *
   * Application Default Credentials are attached only to a Google API host
   * reached over TLS. Anything the caller's own `headerProvider` returns is
   * merged on top.
   */
  private async mcpHeaders(
    serverUrl: string,
    context?: ReadonlyContext,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (isHttpsGoogleApi(serverUrl)) {
      Object.assign(headers, await this.getAuthHeaders());
    }
    if (this.headerProvider) {
      Object.assign(headers, await this.headerProvider(context));
    }
    return headers;
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
      const certs = await clientCertsToPresent();
      const listUrl = this.listUrl(apiRegistryUrl(certs !== undefined));
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
        const body = await readListingPage(
          `${listUrl}?${params.toString()}`,
          headers,
          certs,
        );
        const data = JSON.parse(body) as ListApiRegistryMcpServersResponse;
        for (const server of data.mcpServers ?? []) {
          if (server.name) {
            servers.set(server.name, server);
          }
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Error fetching MCP servers from API Registry: ${msg}`, {
        cause: err,
      });
    }
    return servers;
  }

  /** Builds the `mcpServers.list` URL against `baseUrl`. */
  private listUrl(baseUrl: string): string {
    return (
      `${baseUrl}/${API_REGISTRY_API_VERSION}` +
      `/projects/${this.projectId}/locations/${this.location}/mcpServers`
    );
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
    // GoogleAuth exposes no quota project of its own; getClient() copies the
    // one from Application Default Credentials onto the client.
    if (client.quotaProjectId) {
      headers['x-goog-user-project'] = client.quotaProjectId;
    }
    return headers;
  }
}
