/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';
import {AutoAuthCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthProviderRegistry} from './auth_provider_registry.js';
import {
  AuthScheme,
  AuthSchemeType,
  CustomAuthScheme,
  OAuthGrantType,
  isCustomAuthScheme,
  isOAuth2Scheme,
} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {BaseAuthProvider} from './base_auth_provider.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
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

/**
 * Whether the credential is usable as it stands, with no exchange or refresh.
 */
function isReadyToUse(credential: AuthCredential): boolean {
  return (
    credential.authType === AuthCredentialTypes.API_KEY ||
    credential.authType === AuthCredentialTypes.HTTP
  );
}

/**
 * Whether the scheme authenticates the application itself, so the raw
 * credential is enough and no end user has to grant consent.
 */
function isClientCredentialsFlow(authScheme: AuthScheme): boolean {
  if (isOAuth2Scheme(authScheme)) {
    return authScheme.flows.clientCredentials !== undefined;
  }
  const grantTypes =
    'grantTypesSupported' in authScheme
      ? authScheme.grantTypesSupported
      : undefined;
  return grantTypes?.includes(OAuthGrantType.CLIENT_CREDENTIALS) ?? false;
}

/**
 * The first flow URL an OAuth2 scheme declares a flow for but leaves empty, as
 * a dotted field path. `undefined` when the scheme is complete.
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
 * Rejects a config that cannot produce a credential, naming the field at
 * fault.
 *
 * An OAuth2 endpoint that the scheme declares but leaves empty is first
 * discovered from the issuer. Only a scheme that discovery cannot complete is
 * rejected.
 *
 * @param authConfig The config to validate.
 * @param discoveryManager The manager that fetches the issuer's metadata.
 * @throws Error if the config is incomplete.
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
    return;
  }

  if (
    (rawAuthCredential.authType === AuthCredentialTypes.OAUTH2 ||
      rawAuthCredential.authType === AuthCredentialTypes.OPEN_ID_CONNECT) &&
    !rawAuthCredential.oauth2
  ) {
    throw new Error(
      `authConfig.rawAuthCredential.oauth2 is required for credential type ${rawAuthCredential.authType}`,
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
 * The exchangers this manager overrides on {@link AutoAuthCredentialExchanger}.
 *
 * That exchanger's built-in OAuth2 entry converts the access token into the
 * HTTP bearer credential the OpenAPI tool layer sends in its Authorization
 * header. A tool reads the token from `credential.oauth2`, so the manager keeps
 * the plain token exchange and leaves the conversion to the OpenAPI layer.
 */
const OAUTH2_EXCHANGERS: ReadonlyMap<
  AuthCredentialTypes,
  BaseCredentialExchanger
> = new Map([
  [AuthCredentialTypes.OAUTH2, new OAuth2CredentialExchanger()],
  [AuthCredentialTypes.OPEN_ID_CONNECT, new OAuth2CredentialExchanger()],
]);

/**
 * Renews an expired credential through the refresher registered for its type.
 *
 * A type with no refresher, and a credential that is still valid, both come
 * back unchanged.
 */
async function refreshCredential(
  credential: AuthCredential,
  authScheme: AuthScheme,
  registry: CredentialRefresherRegistry,
): Promise<ExchangeResult> {
  // Typed as the interface, so both calls pass the scheme the contract
  // declares rather than binding to what a refresher happens to read.
  const refresher: BaseCredentialRefresher | undefined = registry.getRefresher(
    credential.authType,
  );
  if (
    !refresher ||
    !(await refresher.isRefreshNeeded(credential, authScheme))
  ) {
    return {credential, wasExchanged: false};
  }
  return {
    credential: await refresher.refresh(credential, authScheme),
    wasExchanged: true,
  };
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
 * @return The provider's credential, or `undefined` when the provider produced
 *     a consent URI and the end user still has to authorize.
 * @throws Error if no provider serves the scheme, or if the provider returns
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
 * Resolves the credential an authenticated tool runs with.
 *
 * One manager serves one {@link AuthConfig}. It resolves a scheme outside the
 * OpenAPI 3.0 set through its registered provider. For every other scheme it
 * reads a stored credential, falls back to the answer the client sent back from
 * a consent flow, exchanges or refreshes it when the scheme requires that, and
 * saves the result. When nothing yields a credential the tool asks the client
 * for one and the invocation pauses.
 *
 * The manager keeps no per-call state, so one instance serves concurrent calls
 * from different users. Anything it would mutate it copies first.
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
  /**
   * The exchanger this manager runs a credential through, built once so a
   * caller can replace an entry with
   * {@link CredentialManager.registerCredentialExchanger}.
   */
  private readonly exchanger = new AutoAuthCredentialExchanger(
    OAUTH2_EXCHANGERS,
  );

  /**
   * The refresher for each credential type, so a caller can replace an entry
   * with {@link CredentialManager.registerCredentialRefresher}.
   */
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

  constructor(private readonly authConfig: AuthConfig) {
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
   * Registers a credential exchanger for a credential type, replacing the
   * default one when there is one.
   *
   * @param credentialType The credential type to exchange.
   * @param exchanger The exchanger to run for that type.
   */
  registerCredentialExchanger(
    credentialType: AuthCredentialTypes,
    exchanger: BaseCredentialExchanger,
  ): void {
    this.exchanger.exchangers.set(credentialType, exchanger);
  }

  /**
   * Registers a credential refresher for a credential type, replacing the
   * default one when there is one.
   *
   * @param credentialType The credential type to refresh.
   * @param refresher The refresher to run for that type.
   */
  registerCredentialRefresher(
    credentialType: AuthCredentialTypes,
    refresher: BaseCredentialRefresher,
  ): void {
    this.refresherRegistry.register(credentialType, refresher);
  }

  /**
   * Asks the client to supply a credential. The invocation pauses until the
   * client answers.
   *
   * @param context The context of the tool call that needs the credential.
   */
  requestCredential(context: Context): void {
    context.requestCredential(this.authConfig);
  }

  /**
   * Resolves the credential for this config.
   *
   * @param context The context of the tool call that needs the credential.
   * @return The credential, or `undefined` when the client must supply one.
   * @throws Error if the config cannot produce a credential, or if an exchange
   *     or a refresh fails.
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
      // A long-lived AuthConfig is shared across invocations and users, and a
      // caller is free to mutate what it receives.
      return cloneDeep(rawAuthCredential);
    }

    // A service account authenticates the application, so its token is not
    // the end user's to store or to reuse.
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

    const exchanged = await this.exchanger.exchange({
      authCredential: credential,
      authScheme,
    });
    // An exchange already produces a fresh token, so a refresh on top of it
    // would spend a second round trip for nothing.
    const resolved = exchanged.wasExchanged
      ? exchanged
      : await refreshCredential(
          exchanged.credential,
          authScheme,
          this.refresherRegistry,
        );

    if ((fromAuthResponse || resolved.wasExchanged) && !isServiceAccount) {
      await saveCredential(this.authConfig, resolved.credential, context);
    }

    return resolved.credential;
  }
}
