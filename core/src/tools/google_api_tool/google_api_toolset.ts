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
import type {ClosableDispatcher} from '../../utils/ssl_utils.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {GoogleApiTool} from './google_api_tool.js';
import {GoogleApiToOpenApiConverter} from './googleapi_to_openapi_converter.js';

/** The OpenID Connect discovery document Google publishes. */
const OPENID_CONFIGURATION_URL =
  'https://accounts.google.com/.well-known/openid-configuration';

/** Where a user grants consent. */
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Where an authorization code is exchanged for a token. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Where a token is revoked. */
const REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** How the client authenticates itself at the token endpoint. */
const TOKEN_ENDPOINT_AUTH_METHODS = [
  'client_secret_post',
  'client_secret_basic',
];

/** The only grant Google's user consent flow supports here. */
const GRANT_TYPES = ['authorization_code'];

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

  /**
   * Selects which of the API's operations are exposed to the model. A name
   * list matches the prefixed name, because `toolNamePrefix` is applied while
   * the tools are built.
   */
  toolFilter?: ToolPredicate | string[];

  /** Calls the API as this service account instead of as a user. */
  serviceAccount?: ServiceAccount;

  /** Prepended to every tool name, separated by an underscore. */
  toolNamePrefix?: string;

  /** Headers merged into every request; an existing header always wins. */
  additionalHeaders?: Record<string, string>;

  /** Scopes requested on top of the API's first Discovery scope. */
  additionalScopes?: string[];

  /** An alternative Discovery URL template. */
  discoveryUrl?: string;
}

/** Options for a prebuilt toolset, whose API and version are fixed. */
export type GoogleApiToolsetPresetOptions = Omit<
  GoogleApiToolsetOptions,
  'apiName' | 'apiVersion'
>;

/**
 * Builds the OpenID Connect scheme the Google API tools authenticate with.
 *
 * The scopes are the API's first Discovery scope followed by
 * `additionalScopes`, de-duplicated with the order kept. A converted spec that
 * declares no OAuth2 scheme yields `additionalScopes` alone.
 *
 * @param spec The converted OpenAPI document.
 * @param additionalScopes The scopes to request on top of the first one.
 * @returns The auth scheme for the API's tools.
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

  return {
    type: 'openIdConnect',
    openIdConnectUrl: OPENID_CONFIGURATION_URL,
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    revocationEndpoint: REVOCATION_ENDPOINT,
    tokenEndpointAuthMethodsSupported: TOKEN_ENDPOINT_AUTH_METHODS,
    grantTypesSupported: GRANT_TYPES,
    scopes: [...new Set([...discoveryScopes.slice(0, 1), ...additionalScopes])],
  };
}

/**
 * A toolset built from a Google API Discovery document.
 *
 * The toolset fetches the API's Discovery document, converts it to OpenAPI,
 * and exposes one {@link GoogleApiTool} per operation the filter selects. The
 * fetch happens on the first {@link getTools} call and once per instance.
 *
 * Seven prebuilt subclasses pin a specific Google API. Use this class directly
 * for any other API the Discovery service describes.
 *
 * @example
 * ```ts
 * const drive = new GoogleApiToolset({
 *   apiName: 'drive',
 *   apiVersion: 'v3',
 *   clientId,
 *   clientSecret,
 * });
 * ```
 */
@experimental
export class GoogleApiToolset extends BaseToolset {
  readonly apiName: string;
  readonly apiVersion: string;

  private clientId?: string;
  private clientSecret?: string;
  private serviceAccount?: ServiceAccount;
  private readonly additionalHeaders?: Record<string, string>;
  private readonly additionalScopes?: string[];
  private readonly discoveryUrl?: string;
  private openApiToolsetPromise?: Promise<OpenAPIToolset>;
  private mtlsDispatcher?: ClosableDispatcher;

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
  }

  /**
   * Returns one tool per selected operation of the API.
   *
   * The tools are built fresh on every call, so a {@link configureAuth} or
   * {@link configureSaAuth} call between two calls takes effect on the second.
   *
   * @param context Context the predicate filter is evaluated against.
   * @returns The selected tools, each carrying the toolset's credentials.
   */
  @experimental
  override async getTools(context?: ReadonlyContext): Promise<GoogleApiTool[]> {
    const openApiToolset = await this.loadOpenApiToolset();
    const restApiTools = await openApiToolset.getTools(context);
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
   * Sets the OAuth2 client the tools run the user consent flow with.
   *
   * @param clientId The OAuth2 client id.
   * @param clientSecret The OAuth2 client secret.
   */
  @experimental
  configureAuth(clientId: string, clientSecret: string): void {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Sets the service account the tools call the API as.
   *
   * @param serviceAccount The service account configuration.
   */
  @experimental
  configureSaAuth(serviceAccount: ServiceAccount): void {
    this.serviceAccount = serviceAccount;
  }

  /**
   * Replaces the filter that selects which operations are exposed.
   *
   * @param toolFilter The new filter.
   */
  @experimental
  setToolFilter(toolFilter: ToolPredicate | string[]): void {
    this.toolFilter = toolFilter;
  }

  /**
   * Closes the toolset and releases the client certificate it presents.
   *
   * A toolset that presented a certificate also forgets its memoised tools,
   * because those tools hold the dispatcher that is about to be destroyed. A
   * toolset that presented none keeps them: a runner closes its toolsets after
   * every invocation, so forgetting them would refetch the Discovery document
   * once per turn.
   */
  @experimental
  override async close(): Promise<void> {
    // A failed conversion was already reported by getTools; closing must not
    // surface it a second time and fail teardown.
    const openApiToolset = await this.openApiToolsetPromise?.catch(
      () => undefined,
    );
    const dispatcher = this.takeMtlsDispatcher();
    if (dispatcher) {
      this.openApiToolsetPromise = undefined;
    }
    await openApiToolset?.close();
    await dispatcher?.close();
  }

  private loadOpenApiToolset(): Promise<OpenAPIToolset> {
    // The promise is memoised, not the toolset, so concurrent getTools calls
    // share one discovery fetch. A failed load is forgotten so a later call
    // retries instead of replaying the error for the toolset's lifetime.
    this.openApiToolsetPromise ??= this.buildOpenApiToolset().catch(
      async (error: unknown) => {
        this.openApiToolsetPromise = undefined;
        await this.takeMtlsDispatcher()?.close();
        throw error;
      },
    );
    return this.openApiToolsetPromise;
  }

  private async buildOpenApiToolset(): Promise<OpenAPIToolset> {
    const converter = new GoogleApiToOpenApiConverter(
      this.apiName,
      this.apiVersion,
      {discoveryUrl: this.discoveryUrl},
    );
    const spec = await converter.convert();

    const certs = await clientCertsToPresent();
    this.mtlsDispatcher = certs ? await clientCertDispatcher(certs) : undefined;

    // The filter stays with this toolset: OpenAPIToolset captures its own at
    // construction, so a later setToolFilter call would not reach it.
    return new OpenAPIToolset({
      specDict: spec,
      prefix: this.prefix,
      authScheme: googleOidcAuthScheme(spec, this.additionalScopes),
      dispatcher: this.mtlsDispatcher,
    });
  }

  /**
   * Detaches the dispatcher that owns the client certificate, so the caller
   * can close it. Detaching before the close leaves no window in which a
   * second caller closes the same dispatcher.
   */
  private takeMtlsDispatcher(): ClosableDispatcher | undefined {
    const dispatcher = this.mtlsDispatcher;
    this.mtlsDispatcher = undefined;
    return dispatcher;
  }
}
