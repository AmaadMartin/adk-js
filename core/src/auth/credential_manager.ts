/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';
import {OpenAPIV3} from 'openapi-types';

import {Context} from '../agents/context.js';
import {ServiceAccountCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthProviderRegistry} from './auth_provider_registry.js';
import {AuthScheme} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {BaseAuthProvider} from './base_auth_provider.js';
import {BaseCredentialExchanger} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {OAuth2DiscoveryManager} from './oauth2/oauth2_discovery.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/** Scheme types defined by the OpenAPI security scheme object. */
const OPEN_API_SCHEME_TYPES: ReadonlySet<string> = new Set([
  'apiKey',
  'http',
  'oauth2',
  'openIdConnect',
]);

/** Credential types usable as-is, with no exchange or refresh. */
const READY_CREDENTIAL_TYPES: ReadonlySet<AuthCredentialTypes> = new Set([
  AuthCredentialTypes.API_KEY,
  AuthCredentialTypes.HTTP,
]);

/** Scheme types that cannot produce a credential without a raw one. */
const RAW_CREDENTIAL_REQUIRED_SCHEME_TYPES: ReadonlySet<string> = new Set([
  'oauth2',
  'openIdConnect',
]);

/** Credential types whose raw form must carry an `oauth2` block. */
const OAUTH2_CREDENTIAL_TYPES: ReadonlySet<AuthCredentialTypes> = new Set([
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
]);

const CLIENT_CREDENTIALS_GRANT_TYPE = 'client_credentials';

/**
 * An OAuth2 scheme that also carries the issuer URL used for RFC8414
 * auto-discovery. `AuthScheme` does not declare the field, so read it through
 * this extension rather than a cast.
 */
interface OAuth2SchemeWithIssuer extends OpenAPIV3.OAuth2SecurityScheme {
  issuerUrl?: string;
}

/**
 * An OpenID Connect scheme that also declares its supported grant types.
 * `OpenIdConnectWithConfig` has the field; the plain OpenAPI scheme does not.
 */
interface OidcSchemeWithGrantTypes extends OpenAPIV3.OpenIdSecurityScheme {
  grantTypesSupported?: string[];
}

/**
 * Reports whether a raw credential can be used without exchange or refresh.
 *
 * @param rawCredential The raw credential from the auth config.
 * @returns True when the credential is present and needs no processing.
 */
export function isCredentialReady(rawCredential?: AuthCredential): boolean {
  return !!rawCredential && READY_CREDENTIAL_TYPES.has(rawCredential.authType);
}

/**
 * Reports whether the scheme uses the OAuth2 client credentials flow.
 *
 * @param authScheme The auth scheme to inspect.
 * @returns True for an OAuth2 scheme declaring a `clientCredentials` flow, or
 *     an OIDC scheme listing `client_credentials` in its grant types.
 */
export function isClientCredentialsFlow(authScheme: AuthScheme): boolean {
  if (authScheme.type === 'oauth2') {
    return !!authScheme.flows?.clientCredentials;
  }
  if (authScheme.type === 'openIdConnect') {
    const oidcScheme: OidcSchemeWithGrantTypes = authScheme;
    return (
      oidcScheme.grantTypesSupported?.includes(
        CLIENT_CREDENTIALS_GRANT_TYPE,
      ) === true
    );
  }
  return false;
}

/**
 * Reports whether an OAuth2 scheme is missing an endpoint one of its flows
 * needs.
 *
 * @param authScheme The auth scheme to inspect.
 * @returns True when a declared flow has no authorization or token URL.
 */
export function missingOAuthInfo(authScheme: AuthScheme): boolean {
  if (authScheme.type !== 'oauth2' || !authScheme.flows) {
    return false;
  }
  const {implicit, password, clientCredentials, authorizationCode} =
    authScheme.flows;
  return (
    (!!implicit && !implicit.authorizationUrl) ||
    (!!password && !password.tokenUrl) ||
    (!!clientCredentials && !clientCredentials.tokenUrl) ||
    (!!authorizationCode && !authorizationCode.authorizationUrl) ||
    (!!authorizationCode && !authorizationCode.tokenUrl)
  );
}

/**
 * Fills the empty endpoints of an OAuth2 scheme from its issuer's published
 * metadata. Endpoints that are already set are left alone. The scheme is
 * modified in place.
 *
 * @param authScheme The auth scheme to populate.
 * @param discoveryManager The manager that fetches the server metadata.
 * @returns True when discovery succeeded, false otherwise.
 */
export async function populateAuthScheme(
  authScheme: AuthScheme,
  discoveryManager: OAuth2DiscoveryManager,
): Promise<boolean> {
  const scheme: OAuth2SchemeWithIssuer | undefined =
    authScheme.type === 'oauth2' ? authScheme : undefined;
  if (!scheme?.issuerUrl) {
    logger.warn('No issuerUrl was provided for auto-discovery.');
    return false;
  }

  const metadata = await discoveryManager.discoverAuthServerMetadata(
    scheme.issuerUrl,
  );
  if (!metadata) {
    logger.warn('Auto-discovery has failed to populate OAuth scheme info.');
    return false;
  }

  const {implicit, password, clientCredentials, authorizationCode} =
    scheme.flows;
  if (implicit && !implicit.authorizationUrl) {
    implicit.authorizationUrl = metadata.authorization_endpoint;
  }
  if (password && !password.tokenUrl) {
    password.tokenUrl = metadata.token_endpoint;
  }
  if (clientCredentials && !clientCredentials.tokenUrl) {
    clientCredentials.tokenUrl = metadata.token_endpoint;
  }
  if (authorizationCode && !authorizationCode.authorizationUrl) {
    authorizationCode.authorizationUrl = metadata.authorization_endpoint;
  }
  if (authorizationCode && !authorizationCode.tokenUrl) {
    authorizationCode.tokenUrl = metadata.token_endpoint;
  }
  return true;
}

/**
 * Validates an auth config, and auto-discovers any OAuth2 endpoint the scheme
 * declares but does not carry.
 *
 * @param authConfig The auth config to validate.
 * @param discoveryManager The manager that fetches the server metadata.
 * @throws {Error} When the config cannot produce a credential.
 */
export async function validateCredential(
  authConfig: AuthConfig,
  discoveryManager: OAuth2DiscoveryManager,
): Promise<void> {
  const {authScheme, rawAuthCredential} = authConfig;

  if (
    !rawAuthCredential &&
    RAW_CREDENTIAL_REQUIRED_SCHEME_TYPES.has(authScheme.type)
  ) {
    throw new Error(
      `rawAuthCredential is required for auth scheme type ${authScheme.type}`,
    );
  }

  if (
    rawAuthCredential &&
    OAUTH2_CREDENTIAL_TYPES.has(rawAuthCredential.authType) &&
    !rawAuthCredential.oauth2
  ) {
    throw new Error(
      'authConfig.rawAuthCredential.oauth2 is required for credential type ' +
        `${rawAuthCredential.authType}`,
    );
  }

  if (
    missingOAuthInfo(authScheme) &&
    !(await populateAuthScheme(authScheme, discoveryManager))
  ) {
    throw new Error(
      'OAuth scheme info is missing, and auto-discovery has failed to fill' +
        ' them in.',
    );
  }
}

/**
 * Manages authentication credentials through a structured workflow.
 *
 * The CredentialManager orchestrates the complete lifecycle of an
 * authentication credential, from initial loading to final preparation for
 * use. It validates the config, resolves a custom scheme through a registered
 * provider, loads a stored credential, exchanges it, refreshes it when it has
 * expired, and persists the result.
 *
 * This class is only for use by Agent Development Kit.
 *
 * @example
 * ```ts
 * const manager = new CredentialManager(authConfig);
 *
 * const credential = await manager.getAuthCredential(context);
 * if (!credential) {
 *   await manager.requestCredential(context);
 * }
 * ```
 */
@experimental
export class CredentialManager {
  private static readonly authProviderRegistry = new AuthProviderRegistry();

  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();
  private readonly discoveryManager = new OAuth2DiscoveryManager();

  /**
   * Registers a provider that serves a custom (non-OpenAPI) auth scheme.
   *
   * The first provider registered for a scheme type wins. A later, different
   * provider for the same type is ignored with a warning.
   *
   * @param authSchemeType The `type` of the custom scheme the provider serves.
   * @param provider The provider instance to register.
   */
  static registerAuthProvider(
    authSchemeType: string,
    provider: BaseAuthProvider,
  ): void {
    const existing =
      CredentialManager.authProviderRegistry.getProviderByType(authSchemeType);
    if (existing === provider) {
      return;
    }
    if (existing) {
      logger.warn(
        `An auth provider is already registered for scheme ${authSchemeType}.` +
          ' Ignoring the new provider.',
      );
      return;
    }
    CredentialManager.authProviderRegistry.register(authSchemeType, provider);
  }

  /**
   * @param authConfig The auth config whose credential lifecycle this manager
   *     owns.
   */
  constructor(private readonly authConfig: AuthConfig) {
    const oauth2Exchanger = new OAuth2CredentialExchanger();
    this.exchangerRegistry.register(
      AuthCredentialTypes.OAUTH2,
      oauth2Exchanger,
    );
    this.exchangerRegistry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2Exchanger,
    );
    this.exchangerRegistry.register(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new ServiceAccountCredentialExchanger(),
    );

    const oauth2Refresher = new OAuth2CredentialRefresher();
    this.refresherRegistry.register(
      AuthCredentialTypes.OAUTH2,
      oauth2Refresher,
    );
    this.refresherRegistry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2Refresher,
    );
  }

  /**
   * Overrides the exchanger used for one credential type on this manager.
   *
   * @param credentialType The credential type to register for.
   * @param exchanger The exchanger instance to register.
   */
  registerCredentialExchanger(
    credentialType: AuthCredentialTypes,
    exchanger: BaseCredentialExchanger,
  ): void {
    this.exchangerRegistry.register(credentialType, exchanger);
  }

  /**
   * Asks the client to collect a credential from the end user.
   *
   * @param context The context of the current tool call.
   */
  async requestCredential(context: Context): Promise<void> {
    context.requestCredential(this.authConfig);
  }

  /**
   * Loads and prepares the authentication credential.
   *
   * @param context The context of the current tool call.
   * @returns The credential ready for use, or undefined when the end user
   *     still has to authorize. Undefined is a control signal, not an error.
   * @throws {Error} When the auth config cannot produce a credential.
   */
  async getAuthCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const authScheme = this.authConfig.authScheme;

    if (!OPEN_API_SCHEME_TYPES.has(authScheme.type)) {
      return this.resolveThroughProvider(context);
    }

    await validateCredential(this.authConfig, this.discoveryManager);

    const rawAuthCredential = this.authConfig.rawAuthCredential;
    if (rawAuthCredential && isCredentialReady(rawAuthCredential)) {
      // Steps below mutate credentials in place, and tools share a long-lived
      // AuthConfig across users, so never hand back the shared object.
      return cloneDeep(rawAuthCredential);
    }

    // A service account credential is minted per exchange and never belongs in
    // the shared credential store, on read or on write.
    const isServiceAccount =
      rawAuthCredential?.authType === AuthCredentialTypes.SERVICE_ACCOUNT;

    let credential = isServiceAccount
      ? undefined
      : await this.loadFromCredentialService(context);

    let wasFromAuthResponse = false;
    if (!credential) {
      credential = context.getAuthResponse(this.authConfig);
      wasFromAuthResponse = true;
    }

    if (!credential) {
      if (!isClientCredentialsFlow(authScheme) || !rawAuthCredential) {
        return undefined;
      }
      credential = cloneDeep(rawAuthCredential);
    }

    let wasExchanged: boolean;
    [credential, wasExchanged] = await this.exchangeCredential(credential);

    let wasRefreshed = false;
    if (!wasExchanged) {
      [credential, wasRefreshed] = await this.refreshCredential(credential);
    }

    if (
      (wasFromAuthResponse || wasExchanged || wasRefreshed) &&
      !isServiceAccount
    ) {
      await this.saveCredential(context, credential);
    }

    return credential;
  }

  private async resolveThroughProvider(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const schemeType = this.authConfig.authScheme.type;
    const provider =
      CredentialManager.authProviderRegistry.getProviderByType(schemeType);
    if (!provider) {
      throw new Error(
        `No auth provider registered for custom auth scheme '${schemeType}'.` +
          ' Register it using `CredentialManager.registerAuthProvider(' +
          '<schemeType>, <yourAuthProviderInstance>)`.',
      );
    }

    const credential = await provider.getAuthCredential(
      this.authConfig,
      context,
    );
    if (!credential) {
      throw new Error('AuthProvider did not return a credential.');
    }

    if (
      credential.oauth2 &&
      !credential.oauth2.accessToken &&
      credential.oauth2.authUri
    ) {
      this.authConfig.exchangedAuthCredential = credential;
      return undefined;
    }
    return credential;
  }

  private async loadFromCredentialService(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialService = context.invocationContext.credentialService;
    if (!credentialService) {
      return undefined;
    }
    return credentialService.loadCredential(this.authConfig, context);
  }

  private async exchangeCredential(
    credential: AuthCredential,
  ): Promise<[AuthCredential, boolean]> {
    const exchanger = this.exchangerRegistry.getExchanger(credential.authType);
    if (!exchanger) {
      return [credential, false];
    }
    const result = await exchanger.exchange({
      authCredential: credential,
      authScheme: this.authConfig.authScheme,
    });
    return [result.credential, result.wasExchanged];
  }

  private async refreshCredential(
    credential: AuthCredential,
  ): Promise<[AuthCredential, boolean]> {
    const refresher = this.refresherRegistry.getRefresher(credential.authType);
    if (!refresher) {
      return [credential, false];
    }
    const authScheme = this.authConfig.authScheme;
    if (await refresher.isRefreshNeeded(credential, authScheme)) {
      return [await refresher.refresh(credential, authScheme), true];
    }
    return [credential, false];
  }

  private async saveCredential(
    context: Context,
    credential: AuthCredential,
  ): Promise<void> {
    const credentialService = context.invocationContext.credentialService;
    if (!credentialService) {
      return;
    }
    // The live config is shared across users; persist a copy of it instead.
    const authConfigToSave = cloneDeep(this.authConfig);
    authConfigToSave.exchangedAuthCredential = credential;
    await credentialService.saveCredential(authConfigToSave, context);
  }
}
