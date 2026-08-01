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
import {logger} from '../../utils/logger.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';
import {GoogleApiTool} from './google_api_tool.js';
import {GoogleApiToOpenApiConverter} from './googleapi_to_openapi_converter.js';

const OPENID_CONFIGURATION_URL =
  'https://accounts.google.com/.well-known/openid-configuration';
const OIDC_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
const OIDC_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OIDC_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** Options for {@link GoogleApiToolset}. */
export interface GoogleApiToolsetOptions {
  /** The Discovery API id, e.g. `calendar`. */
  apiName: string;
  /** The API version, e.g. `v3`. */
  apiVersion: string;
  /** OAuth2 client id for the user consent flow. */
  clientId?: string;
  /** OAuth2 client secret for the user consent flow. */
  clientSecret?: string;
  /** Selects which of the API's operations are exposed to the model. */
  toolFilter?: ToolPredicate | string[];
  /** Service account used instead of the OAuth2 consent flow. */
  serviceAccount?: ServiceAccount;
  /** Prefix prepended to every tool name, separated by an underscore. */
  prefix?: string;
  /** Headers added to every request, never overwriting an existing one. */
  additionalHeaders?: Record<string, string>;
  /** Scopes requested on top of the API's first Discovery scope. */
  additionalScopes?: string[];
  /** An alternative Discovery URL template. */
  discoveryUrl?: string;
}

/** Options for the pre-built toolsets, whose api and version are fixed. */
export type GoogleApiToolsetPresetOptions = Omit<
  GoogleApiToolsetOptions,
  'apiName' | 'apiVersion'
>;

/**
 * Builds the OpenID Connect scheme the Google API tools authenticate with.
 *
 * The scopes are the API's first Discovery scope followed by
 * `additionalScopes`, de-duplicated in order. A specification with no OAuth2
 * security scheme yields a scheme carrying only `additionalScopes`.
 *
 * @param spec The converted OpenAPI document.
 * @param additionalScopes Scopes to request beyond the Discovery scope.
 * @return The OpenID Connect scheme.
 */
export function googleOidcAuthScheme(
  spec: OpenAPIV3.Document,
  additionalScopes: string[] = [],
): OpenIdConnectWithConfig {
  const scheme = spec.components?.securitySchemes?.['oauth2'];
  const discoveryScopes =
    scheme && 'type' in scheme && scheme.type === 'oauth2'
      ? Object.keys(scheme.flows.authorizationCode?.scopes ?? {})
      : [];

  const scopes = [
    ...new Set([...discoveryScopes.slice(0, 1), ...additionalScopes]),
  ];

  return {
    type: 'openIdConnect',
    openIdConnectUrl: OPENID_CONFIGURATION_URL,
    authorizationEndpoint: OIDC_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: OIDC_TOKEN_ENDPOINT,
    revocationEndpoint: OIDC_REVOCATION_ENDPOINT,
    tokenEndpointAuthMethodsSupported: [
      'client_secret_post',
      'client_secret_basic',
    ],
    grantTypesSupported: ['authorization_code'],
    scopes,
  };
}

/**
 * A toolset exposing the operations of one Google API.
 *
 * The API's Discovery document is converted to an OpenAPI document on the
 * first {@link GoogleApiToolset.getTools} call and reused afterwards, so a
 * toolset costs exactly one outbound request no matter how often it is asked
 * for its tools.
 *
 * @example
 * ```ts
 * const toolset = new GoogleApiToolset({apiName: 'drive', apiVersion: 'v3'});
 * const agent = new LlmAgent({name: 'files', model, tools: [toolset]});
 * ```
 */
@experimental
export class GoogleApiToolset extends BaseToolset {
  /**
   * Redeclared as mutable so {@link GoogleApiToolset.setToolFilter} can
   * replace the filter after construction.
   */
  override toolFilter: ToolPredicate | string[];

  private readonly apiName: string;
  private readonly apiVersion: string;
  private readonly additionalHeaders?: Record<string, string>;
  private readonly additionalScopes?: string[];
  private readonly discoveryUrl?: string;
  private clientId?: string;
  private clientSecret?: string;
  private serviceAccount?: ServiceAccount;
  private openApiToolsetPromise?: Promise<OpenAPIToolset>;

  constructor(options: GoogleApiToolsetOptions) {
    super(options.toolFilter ?? [], options.prefix);
    this.toolFilter = options.toolFilter ?? [];
    this.apiName = options.apiName;
    this.apiVersion = options.apiVersion;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.serviceAccount = options.serviceAccount;
    this.additionalHeaders = options.additionalHeaders;
    this.additionalScopes = options.additionalScopes;
    this.discoveryUrl = options.discoveryUrl;
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<GoogleApiTool[]> {
    const openApiToolset = await this.loadOpenApiToolset();
    const tools = await openApiToolset.getTools(context);

    return this.selectTools(tools, context).map(
      (tool) =>
        new GoogleApiTool(tool, {
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          serviceAccount: this.serviceAccount,
          additionalHeaders: this.additionalHeaders,
        }),
    );
  }

  /** Replaces the filter applied by the next `getTools` call. */
  @experimental
  setToolFilter(toolFilter: ToolPredicate | string[]): void {
    this.toolFilter = toolFilter;
  }

  /** Authenticates through the OAuth2 user consent flow. */
  @experimental
  configureAuth(clientId: string, clientSecret: string): void {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /** Authenticates as the given service account. */
  @experimental
  configureSaAuth(serviceAccount: ServiceAccount): void {
    this.serviceAccount = serviceAccount;
  }

  @experimental
  override async close(): Promise<void> {
    // A failed conversion was already reported by getTools; closing must not
    // fail teardown by surfacing it a second time.
    const openApiToolset = await this.openApiToolsetPromise?.catch(
      () => undefined,
    );
    await openApiToolset?.close();
  }

  private loadOpenApiToolset(): Promise<OpenAPIToolset> {
    // The promise, not the resolved toolset, is memoised so concurrent
    // getTools calls share a single discovery fetch.
    this.openApiToolsetPromise ??= this.buildOpenApiToolset();
    return this.openApiToolsetPromise;
  }

  private async buildOpenApiToolset(): Promise<OpenAPIToolset> {
    const spec = await new GoogleApiToOpenApiConverter(
      this.apiName,
      this.apiVersion,
      {discoveryUrl: this.discoveryUrl},
    ).convert();

    // The filter is applied by this toolset, not the inner one.
    return new OpenAPIToolset({
      specDict: spec,
      prefix: this.prefix,
      authScheme: googleOidcAuthScheme(spec, this.additionalScopes),
    });
  }

  private selectTools(
    tools: RestApiTool[],
    context?: ReadonlyContext,
  ): RestApiTool[] {
    if (context) {
      return tools.filter((tool) => this.isToolSelected(tool, context));
    }

    const filter = this.toolFilter;
    if (Array.isArray(filter)) {
      // An empty filter selects every tool.
      return filter.length === 0
        ? tools
        : tools.filter((tool) => filter.includes(tool.name));
    }

    logger.warn(
      'GoogleApiToolset: a ToolPredicate toolFilter was provided but ' +
        'getTools() was called without a ReadonlyContext. The filter will ' +
        'not be applied.',
    );
    return tools;
  }
}
