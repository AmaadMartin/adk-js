/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import type {Context} from '../agents/context.js';
import {ServiceAccountCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthProviderRegistry} from './auth_provider_registry.js';
import {
  AuthScheme,
  AuthSchemeType,
  CustomAuthScheme,
  isCustomAuthScheme,
  isOAuth2Scheme,
  isOpenIdConnectWithConfig,
  OAuthGrantType,
} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {BaseAuthProvider} from './base_auth_provider.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {OAuth2DiscoveryManager} from './oauth2/oauth2_discovery.js';
import {populateAuthSchemeFromDiscovery} from './oauth2/oauth2_utils.js';
import {BaseCredentialRefresher} from './refresher/base_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/**
 * The process-wide registry of providers for custom auth schemes.
 *
 * adk-python guards its equivalent with a `threading.Lock`. JavaScript runs
 * this on one event loop and neither registration nor lookup awaits, so a lock
 * would add no protection here.
 */
const authProviderRegistry = new AuthProviderRegistry();

/** Reports whether a credential is usable without exchange or refresh. */
function isReadyToUse(credential: AuthCredential): boolean {
  return (
    credential.authType === AuthCredentialTypes.API_KEY ||
    credential.authType === AuthCredentialTypes.HTTP
  );
}

/**
 * Reports whether a scheme uses the OAuth2 client credentials flow, which the
 * agent can complete on its own without asking the end user to authorize.
 */
function isClientCredentialsFlow(authScheme: AuthScheme): boolean {
  if (isOAuth2Scheme(authScheme)) {
    return !!authScheme.flows.clientCredentials;
  }
  if (isOpenIdConnectWithConfig(authScheme)) {
    return (
      authScheme.grantTypesSupported?.includes(
        OAuthGrantType.CLIENT_CREDENTIALS,
      ) === true
    );
  }
  return false;
}

/**
 * Returns the dotted path of the first endpoint an OAuth2 scheme declares a
 * flow for but leaves empty, or undefined when nothing is missing.
 */
function missingOAuth2FlowUrl(authScheme: AuthScheme): string | undefined {
  if (!isOAuth2Scheme(authScheme)) {
    return undefined;
  }
  const {implicit, password, clientCredentials, authorizationCode} =
    authScheme.flows;
  if (implicit && !implicit.authorizationUrl) {
    return 'flows.implicit.authorizationUrl';
  }
  if (password && !password.tokenUrl) {
    return 'flows.password.tokenUrl';
  }
  if (clientCredentials && !clientCredentials.tokenUrl) {
    return 'flows.clientCredentials.tokenUrl';
  }
  if (authorizationCode && !authorizationCode.authorizationUrl) {
    return 'flows.authorizationCode.authorizationUrl';
  }
  if (authorizationCode && !authorizationCode.tokenUrl) {
    return 'flows.authorizationCode.tokenUrl';
  }
  return undefined;
}

/**
 * Validates that an auth config can produce a credential, and auto-discovers
 * any OAuth2 endpoint whose flow is declared but whose URL is empty.
 *
 * @param authConfig The auth config to validate.
 * @param discoveryManager The manager that fetches the issuer's metadata.
 * @throws {Error} When the config cannot produce a credential.
 */
async function validateAuthConfig(
  authConfig: AuthConfig,
  discoveryManager: OAuth2DiscoveryManager,
): Promise<void> {
  const {authScheme, rawAuthCredential} = authConfig;

  if (!rawAuthCredential) {
    if (
      authScheme.type === AuthSchemeType.OAUTH2 ||
      authScheme.type === AuthSchemeType.OPEN_ID_CONNECT
    ) {
      throw new Error(
        `rawAuthCredential is required for auth scheme type ${authScheme.type}`,
      );
    }
  } else if (
    (rawAuthCredential.authType === AuthCredentialTypes.OAUTH2 ||
      rawAuthCredential.authType === AuthCredentialTypes.OPEN_ID_CONNECT) &&
    !rawAuthCredential.oauth2
  ) {
    throw new Error(
      'authConfig.rawAuthCredential.oauth2 is required for credential type ' +
        `${rawAuthCredential.authType}`,
    );
  }

  const missingUrl = missingOAuth2FlowUrl(authScheme);
  if (
    missingUrl &&
    !(await populateAuthSchemeFromDiscovery(authScheme, discoveryManager))
  ) {
    throw new Error(
      'OAuth scheme info is missing, and auto-discovery has failed to fill ' +
        `them in: authConfig.authScheme.${missingUrl} is required for the ` +
        'declared OAuth2 flow',
    );
  }
}

/**
 * Exchanges a credential through the exchanger registered for its type.
 *
 * @returns The exchanged credential, or the credential unchanged with
 *     `wasExchanged: false` when no exchanger serves its type.
 */
async function exchangeCredential(
  credential: AuthCredential,
  authScheme: AuthScheme,
  registry: CredentialExchangerRegistry,
): Promise<ExchangeResult> {
  const exchanger = registry.getExchanger(credential.authType);
  if (!exchanger) {
    return {credential, wasExchanged: false};
  }
  return exchanger.exchange({authCredential: credential, authScheme});
}

/**
 * Refreshes an expired credential through the refresher registered for its
 * type.
 *
 * @returns The refreshed credential, or undefined when no refresher serves its
 *     type or the credential is still valid.
 */
async function refreshCredential(
  credential: AuthCredential,
  authScheme: AuthScheme,
  registry: CredentialRefresherRegistry,
): Promise<AuthCredential | undefined> {
  const refresher = registry.getRefresher(credential.authType);
  if (
    !refresher ||
    !(await refresher.isRefreshNeeded(credential, authScheme))
  ) {
    return undefined;
  }
  return refresher.refresh(credential, authScheme);
}

/**
 * Resolves the credential for a scheme outside the OpenAPI 3.0 set through the
 * provider registered for its `type`.
 *
 * adk-python also rehydrates the scheme into its registered subclass first,
 * because Pydantic deserializes an unknown scheme into a generic
 * `CustomAuthScheme` and pushes the extra fields into `model_extra`. A scheme
 * parsed from JSON here is a plain object that keeps every field, and the
 * registry is keyed on the `type` string, so there is no class identity to
 * restore. The one behaviour rehydration adds - rejecting a scheme whose
 * `type` matches no registration - is the throw below.
 *
 * @returns The provider's credential, or undefined when the provider produced
 *     a consent URI and the end user still has to authorize.
 * @throws {Error} When no provider serves the scheme, or the provider returns
 *     nothing.
 */
async function resolveCustomSchemeCredential(
  authConfig: AuthConfig,
  scheme: CustomAuthScheme,
  context: Context,
): Promise<AuthCredential | undefined> {
  const provider = authProviderRegistry.getProvider(scheme);
  if (!provider) {
    throw new Error(
      `No auth provider registered for custom auth scheme '${scheme.type}'. ` +
        'Register it using `CredentialManager.registerAuthProvider(' +
        '<YourAuthProviderInstance>)`.',
    );
  }

  const provided = await provider.getAuthCredential(authConfig, context);
  if (!provided) {
    throw new Error('AuthProvider did not return a credential.');
  }

  if (
    provided.oauth2 &&
    !provided.oauth2.accessToken &&
    provided.oauth2.authUri
  ) {
    authConfig.exchangedAuthCredential = provided;
    return undefined;
  }
  // Returned by identity, matching the reference implementation.
  return provided;
}

/** Persists the resolved credential, when a credential service is configured. */
async function saveCredential(
  authConfig: AuthConfig,
  credential: AuthCredential,
  context: Context,
): Promise<void> {
  const credentialService = context.invocationContext.credentialService;
  if (!credentialService) {
    return;
  }
  // One manager serves many invocations and many users, so persist a deep copy.
  // A shallow copy would share the scheme and the raw credential with the live
  // config, and a store that keeps the object by reference could then reach
  // back into it.
  const authConfigToSave = cloneDeep(authConfig);
  authConfigToSave.exchangedAuthCredential = credential;
  await credentialService.saveCredential(authConfigToSave, context);
}

/**
 * Manages authentication credentials through a structured workflow.
 *
 * The CredentialManager orchestrates the whole lifecycle of a tool's
 * authentication credential. It resolves a custom scheme through its
 * registered provider, validates the config, loads a stored credential,
 * exchanges it, refreshes it when it has expired, and persists the result.
 *
 * This class is only for use by Agent Development Kit.
 *
 * @example
 * ```ts
 * const manager = new CredentialManager(authConfig);
 *
 * const credential = await manager.getAuthCredential(context);
 * if (!credential) {
 *   manager.requestCredential(context);
 * }
 * ```
 */
@experimental
export class CredentialManager {
  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();
  private readonly discoveryManager = new OAuth2DiscoveryManager();

  /**
   * Registers a provider for every scheme type it declares in
   * `supportedAuthSchemes`.
   *
   * The first provider registered for a scheme type wins. Registering a
   * different provider for that type logs a warning and leaves the first one
   * in place. Registering the same instance again is a silent no-op.
   *
   * @param provider The provider instance to register.
   */
  static registerAuthProvider(provider: BaseAuthProvider): void {
    for (const schemeType of provider.supportedAuthSchemes ?? []) {
      const existing = authProviderRegistry.getProvider({type: schemeType});
      if (existing === provider) {
        continue;
      }
      if (existing) {
        logger.warn(
          `An auth provider is already registered for scheme ${schemeType}. ` +
            'Ignoring the new provider.',
        );
        continue;
      }
      authProviderRegistry.register(schemeType, provider);
    }
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
   * Installs the exchanger this manager uses for one credential type,
   * replacing any default.
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
   * Installs the refresher this manager uses for one credential type,
   * replacing any default.
   *
   * @param credentialType The credential type to register for.
   * @param refresher The refresher instance to register.
   */
  registerCredentialRefresher(
    credentialType: AuthCredentialTypes,
    refresher: BaseCredentialRefresher,
  ): void {
    this.refresherRegistry.register(credentialType, refresher);
  }

  /**
   * Asks the client to collect a credential from the end user, which pauses
   * the invocation until the user authorizes.
   *
   * @param context The context of the current tool call.
   * @throws {Error} When the context is not a tool call's, so it has no
   *     function call id to park the request against.
   */
  requestCredential(context: Context): void {
    context.requestCredential(this.authConfig);
  }

  /**
   * Loads and prepares the authentication credential.
   *
   * @param context The context of the current tool call.
   * @returns The credential the tool can use as it is, or undefined when the
   *     end user still has to authorize. Undefined is a control signal, not an
   *     error.
   * @throws {Error} When the auth config cannot produce a credential.
   */
  async getAuthCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const authScheme = this.authConfig.authScheme;

    if (isCustomAuthScheme(authScheme)) {
      return resolveCustomSchemeCredential(
        this.authConfig,
        authScheme,
        context,
      );
    }

    await validateAuthConfig(this.authConfig, this.discoveryManager);

    const rawAuthCredential = this.authConfig.rawAuthCredential;
    if (rawAuthCredential && isReadyToUse(rawAuthCredential)) {
      // The steps below mutate the credential in place, and one manager serves
      // many users, so never hand back the shared object.
      return cloneDeep(rawAuthCredential);
    }

    // A service account credential is minted per exchange and never belongs in
    // the shared credential store, on read or on write.
    const isServiceAccount =
      rawAuthCredential?.authType === AuthCredentialTypes.SERVICE_ACCOUNT;
    const credentialService = context.invocationContext.credentialService;

    let credential = isServiceAccount
      ? undefined
      : await credentialService?.loadCredential(this.authConfig, context);

    let fromAuthResponse = false;
    if (!credential) {
      credential = context.getAuthResponse(this.authConfig);
      fromAuthResponse = credential !== undefined;
    }

    if (!credential) {
      if (!rawAuthCredential || !isClientCredentialsFlow(authScheme)) {
        return undefined;
      }
      credential = cloneDeep(rawAuthCredential);
    }

    const exchanged = await exchangeCredential(
      credential,
      authScheme,
      this.exchangerRegistry,
    );
    credential = exchanged.credential;

    let wasRefreshed = false;
    if (!exchanged.wasExchanged) {
      const refreshed = await refreshCredential(
        credential,
        authScheme,
        this.refresherRegistry,
      );
      if (refreshed) {
        credential = refreshed;
        wasRefreshed = true;
      }
    }

    if (
      (fromAuthResponse || exchanged.wasExchanged || wasRefreshed) &&
      !isServiceAccount
    ) {
      await saveCredential(this.authConfig, credential, context);
    }

    return credential;
  }
}
