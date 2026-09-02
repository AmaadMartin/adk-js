/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {ServiceAccount} from '../../auth/auth_credential.js';
import {OpenIdConnectWithConfig} from '../../auth/auth_schemes.js';
import {experimental} from '../../utils/experimental.js';
import {
  clientCertDispatcher,
  clientCertsToPresent,
} from '../../utils/mtls_utils.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {GoogleApiTool} from './google_api_tool.js';
import {GoogleApiToOpenApiConverter} from './googleapi_to_openapi_converter.js';

/**
 * The OpenID Connect scheme every generated tool authenticates with, less the
 * scopes the Discovery document decides.
 *
 * `authorizationEndpoint` is the `v2` endpoint, which differs from the one the
 * Discovery converter writes into the document's own `oauth2` scheme. Both are
 * deliberate.
 */
const GOOGLE_OIDC_SCHEME: Omit<OpenIdConnectWithConfig, 'scopes'> = {
  type: 'openIdConnect',
  openIdConnectUrl: '',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  tokenEndpointAuthMethodsSupported: [
    'client_secret_post',
    'client_secret_basic',
  ],
  grantTypesSupported: ['authorization_code'],
};

/**
 * Returns the scopes the toolset requests: the document's first Discovery
 * scope, then `additionalScopes`, with duplicates removed and order kept.
 *
 * adk-python indexes the `oauth2` scheme unguarded and raises a `KeyError` for
 * a document that declares none. Here that is not an error: the result is the
 * deduplicated `additionalScopes`.
 */
function authScopes(
  spec: OpenAPIV3.Document,
  additionalScopes?: string[],
): string[] {
  const scheme = spec.components?.securitySchemes?.['oauth2'];
  const discoveryScopes =
    scheme && !('$ref' in scheme) && scheme.type === 'oauth2'
      ? scheme.flows.authorizationCode?.scopes
      : undefined;
  const defaultScope = discoveryScopes && Object.keys(discoveryScopes)[0];
  return [
    ...new Set([
      ...(defaultScope ? [defaultScope] : []),
      ...(additionalScopes ?? []),
    ]),
  ];
}

/** Options for {@link GoogleApiToolset}. */
export interface GoogleApiToolsetOptions {
  /** The Discovery API id, for example `calendar` or `gmail`. */
  apiName: string;

  /** The API version, for example `v3`. */
  apiVersion: string;

  /** The OAuth2 client id for the user consent flow. */
  clientId?: string;

  /** The OAuth2 client secret for the user consent flow. */
  clientSecret?: string;

  /**
   * Selects which of the generated tools the toolset exposes. A name list
   * matches the tool name the toolset exposes, so it includes
   * `toolNamePrefix`.
   */
  toolFilter?: ToolPredicate | string[];

  /** The service account to call the API with. It wins over the client pair. */
  serviceAccount?: ServiceAccount;

  /** Prepended to every generated tool name, separated by an underscore. */
  toolNamePrefix?: string;

  /**
   * Headers merged into every request the generated tools send, such as the
   * developer token Google Ads requires.
   */
  additionalHeaders?: Record<string, string>;

  /** Scopes requested on top of the document's first Discovery scope. */
  additionalScopes?: string[];

  /**
   * An alternative Discovery URL template, which wins over the default one.
   * `{api}` and `{apiVersion}` are substituted when present.
   */
  discoveryUrl?: string;
}

/**
 * Turns a Google API Discovery document into a set of authenticated tools.
 *
 * One toolset serves one Google API. It fetches the Discovery document for
 * `(apiName, apiVersion)`, converts it to OpenAPI, and exposes one
 * {@link GoogleApiTool} per operation, each carrying the toolset's credentials
 * and headers.
 *
 * ```ts
 * const calendar = new GoogleApiToolset({
 *   apiName: 'calendar',
 *   apiVersion: 'v3',
 *   clientId: process.env.OAUTH_CLIENT_ID,
 *   clientSecret: process.env.OAUTH_CLIENT_SECRET,
 *   toolFilter: ['calendar_events_list'],
 * });
 * const agent = new LlmAgent({
 *   name: 'scheduling_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [calendar],
 * });
 * ```
 *
 * A TypeScript constructor cannot await, so the Discovery document arrives
 * after the constructor returns. A document that fails to fetch rejects the
 * first `getTools()` call, and the next call fetches it again.
 *
 * Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` to present the SecureConnect
 * client certificate on both the Discovery fetch and the tool requests.
 */
@experimental
export class GoogleApiToolset extends BaseToolset {
  /** The Discovery API id this toolset serves. */
  readonly apiName: string;

  /** The API version this toolset serves. */
  readonly apiVersion: string;

  private clientId?: string;
  private clientSecret?: string;
  private serviceAccount?: ServiceAccount;
  private readonly additionalHeaders?: Record<string, string>;
  private readonly additionalScopes?: string[];
  private readonly discoveryUrl?: string;
  private openapiToolset?: OpenAPIToolset;
  private prepared?: Promise<void>;

  constructor(options: GoogleApiToolsetOptions) {
    super(options.toolFilter ?? [], options.toolNamePrefix);
    this.apiName = options.apiName;
    this.apiVersion = options.apiVersion;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.serviceAccount = options.serviceAccount;
    this.additionalHeaders = options.additionalHeaders;
    this.additionalScopes = options.additionalScopes;
    this.discoveryUrl = options.discoveryUrl;

    this.prepared = this.prepareToolset();
    // Nothing awaits this promise yet, and an unhandled rejection would end
    // the process. getTools() still reports the failure.
    this.prepared.catch(() => {});
  }

  /**
   * Returns one tool per Discovery operation that passes the tool filter.
   *
   * A tool that fails the filter is never wrapped, so its underlying
   * `RestApiTool` never receives the toolset's credentials or headers.
   */
  @experimental
  override async getTools(context?: ReadonlyContext): Promise<GoogleApiTool[]> {
    this.prepared ??= this.prepareToolset();
    try {
      await this.prepared;
    } catch (e: unknown) {
      // Fetch again on the next call, as the Python SDK does.
      this.prepared = undefined;
      throw e;
    }

    const restApiTools = (await this.openapiToolset?.getTools(context)) ?? [];
    return restApiTools
      .filter((tool) => this.isToolSelected(tool, context))
      .map(
        (tool) =>
          new GoogleApiTool(tool, {
            clientId: this.clientId,
            clientSecret: this.clientSecret,
            serviceAccount: this.serviceAccount,
            additionalHeaders: this.additionalHeaders,
          }),
      );
  }

  /**
   * Replaces the tool filter. The next {@link getTools} call applies it; tools
   * already returned are unaffected.
   */
  @experimental
  setToolFilter(toolFilter: ToolPredicate | string[]): void {
    this.replaceToolFilter(toolFilter);
  }

  /**
   * Sets the OAuth2 user consent credentials. The next {@link getTools} call
   * builds its tools with them.
   */
  @experimental
  configureAuth(clientId: string, clientSecret: string): void {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Sets the service account to call the API with. The next {@link getTools}
   * call builds its tools with it.
   */
  @experimental
  configureSaAuth(serviceAccount: ServiceAccount): void {
    this.serviceAccount = serviceAccount;
  }

  @experimental
  override async close(): Promise<void> {
    // adk-python also deletes the temporary certificate files `httplib2`
    // needs; `mtls_utils` keeps that material in memory, so there is none.
    await this.openapiToolset?.close();
  }

  private async prepareToolset(): Promise<void> {
    const spec = await new GoogleApiToOpenApiConverter(
      this.apiName,
      this.apiVersion,
      {discoveryUrl: this.discoveryUrl},
    ).convert();

    const certs = await clientCertsToPresent();
    this.openapiToolset = new OpenAPIToolset({
      specDict: spec,
      prefix: this.prefix,
      authScheme: {
        ...GOOGLE_OIDC_SCHEME,
        scopes: authScopes(spec, this.additionalScopes),
      },
      sslVerify: certs ? await clientCertDispatcher(certs) : undefined,
    });
  }
}
