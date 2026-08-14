/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {ServiceAccountCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthProviderRegistry} from './auth_provider_registry.js';
import {OAuthGrantType} from './auth_schemes.js';
import {AuthConfig, CustomAuthConfig} from './auth_tool.js';
import {BaseAuthProvider} from './base_auth_provider.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {
  determineGrantType,
  OAuth2CredentialExchanger,
} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/**
 * The credential lifecycle, ported from adk-python's
 * `google/adk/auth/credential_manager.py`.
 *
 * {@link registerAuthProvider} and {@link getCustomSchemeCredential} serve
 * custom schemes, which adk-js carries in a {@link CustomAuthConfig} rather
 * than in the `AuthScheme` union. {@link CredentialManager} composes the
 * remaining steps for the OpenAPI schemes.
 */

/** Registry of the providers {@link registerAuthProvider} records. */
const registry = new AuthProviderRegistry();

/**
 * Registers `provider` for every scheme type it declares in
 * {@link BaseAuthProvider.supportedAuthSchemes}.
 *
 * A scheme type that already has a different provider keeps that provider and
 * is logged. Registering the same instance twice is a no-op.
 */
export function registerAuthProvider(provider: BaseAuthProvider): void {
  for (const schemeType of provider.supportedAuthSchemes) {
    const existing = registry.getProvider({type: schemeType});
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
    registry.register(schemeType, provider);
  }
}

/**
 * Resolves the credential for a custom auth scheme through its registered
 * provider.
 *
 * @param authConfig The config carrying the custom scheme to resolve.
 * @param context The context of the invocation that needs the credential.
 * @returns The credential the provider returned.
 * @throws If no provider is registered for the scheme type, or if the provider
 *   returns no credential.
 */
export async function getCustomSchemeCredential(
  authConfig: CustomAuthConfig,
  context?: ReadonlyContext,
): Promise<AuthCredential> {
  const provider = registry.getProvider(authConfig.authScheme);
  if (!provider) {
    throw new Error(
      `No auth provider registered for custom auth scheme '${authConfig.authScheme.type}'. ` +
        'Register it using `registerAuthProvider(<YourAuthProviderInstance>)`.',
    );
  }

  const credential = await provider.getAuthCredential(authConfig, context);
  if (!credential) {
    throw new Error('AuthProvider did not return a credential.');
  }
  return credential;
}

/** Credential types that are usable as they are, with no exchange or refresh. */
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

/**
 * Runs an auth credential through its full lifecycle: provider dispatch,
 * validation, loading, exchange, refresh and persistence.
 *
 * @example
 * ```ts
 * const manager = new CredentialManager(authConfig);
 * const credential = await manager.getAuthCredential(context);
 * if (!credential) {
 *   context.requestCredential(authConfig);
 *   return 'Pending User Authorization.';
 * }
 * ```
 */
@experimental
export class CredentialManager {
  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();

  /** @param authConfig The scheme and raw credential this manager owns. */
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

  /** Overrides the exchanger this manager uses for a credential type. */
  registerCredentialExchanger(
    credentialType: AuthCredentialTypes,
    exchanger: BaseCredentialExchanger,
  ): void {
    this.exchangerRegistry.register(credentialType, exchanger);
  }

  /**
   * Resolves the credential to use for this invocation.
   *
   * A `SERVICE_ACCOUNT` raw credential resolves to `undefined`: it is not
   * ready, and only the client-credentials flow mints a token without the
   * user. Exchange it through {@link exchangeCredential} instead.
   *
   * @param context The context of the invocation that needs the credential.
   * @returns The credential, or `undefined` when the client must authorize
   *   first. Pass the config to `Context.requestCredential` to ask it to.
   * @throws If the scheme and credential do not agree, or if a registered
   *   provider resolves to nothing. Exchange and refresh errors propagate.
   */
  async getAuthCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const provider = registry.getProvider(this.authConfig.authScheme);
    if (provider) {
      return this.resolveThroughProvider(provider, context);
    }

    validateCredential(this.authConfig);

    const rawCredential = this.authConfig.rawAuthCredential;
    if (isCredentialReady(rawCredential)) {
      return structuredClone(rawCredential);
    }

    let credential = await this.loadFromCredentialService(context);

    let wasFromAuthResponse = false;
    if (!credential) {
      credential = context.getAuthResponse(this.authConfig);
      wasFromAuthResponse = true;
    }

    if (!credential) {
      // Only the client-credentials flow can mint a token from the raw
      // credential alone. Every other flow needs the user to authorize first.
      if (
        !rawCredential ||
        determineGrantType(this.authConfig.authScheme) !==
          OAuthGrantType.CLIENT_CREDENTIALS
      ) {
        return undefined;
      }
      credential = structuredClone(rawCredential);
    }

    const exchanged = await this.exchangeCredential(credential);
    credential = exchanged.credential;

    let wasRefreshed = false;
    if (!exchanged.wasExchanged) {
      const refreshed = await this.refreshCredential(credential);
      credential = refreshed.credential;
      wasRefreshed = refreshed.wasRefreshed;
    }

    if (wasFromAuthResponse || exchanged.wasExchanged || wasRefreshed) {
      await this.saveCredential(context, credential);
    }

    return credential;
  }

  /**
   * Exchanges `credential` through the exchanger registered for its type.
   *
   * @returns The exchanged credential, or `credential` unchanged when no
   *   exchanger serves its type.
   * @throws {CredentialExchangeError} If the exchange fails.
   */
  async exchangeCredential(
    credential: AuthCredential,
  ): Promise<ExchangeResult> {
    const exchanger = this.exchangerRegistry.getExchanger(credential.authType);
    if (!exchanger) {
      return {credential, wasExchanged: false};
    }

    return exchanger.exchange({
      authScheme: this.authConfig.authScheme,
      authCredential: credential,
    });
  }

  private async resolveThroughProvider(
    provider: BaseAuthProvider,
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const credential = await provider.getAuthCredential(
      this.authConfig,
      context,
    );
    if (!credential) {
      throw new Error('AuthProvider did not return a credential.');
    }

    if (credential.oauth2?.authUri && !credential.oauth2.accessToken) {
      // The provider produced an authorization URI instead of a token, so the
      // client has to run the consent flow before this credential is usable.
      this.authConfig.exchangedAuthCredential = credential;
      return undefined;
    }

    return credential;
  }

  private async refreshCredential(
    credential: AuthCredential,
  ): Promise<{credential: AuthCredential; wasRefreshed: boolean}> {
    const refresher = this.refresherRegistry.getRefresher(credential.authType);
    const authScheme = this.authConfig.authScheme;
    if (
      !refresher ||
      !(await refresher.isRefreshNeeded(credential, authScheme))
    ) {
      return {credential, wasRefreshed: false};
    }

    return {
      credential: await refresher.refresh(credential, authScheme),
      wasRefreshed: true,
    };
  }

  private async loadFromCredentialService(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    return context.invocationContext.credentialService?.loadCredential(
      this.authConfig,
      context,
    );
  }

  private async saveCredential(
    context: Context,
    credential: AuthCredential,
  ): Promise<void> {
    // Save a copy: one user's token must never land on an AuthConfig that
    // tools share across invocations.
    return context.invocationContext.credentialService?.saveCredential(
      {...this.authConfig, exchangedAuthCredential: credential},
      context,
    );
  }
}

/** Whether `credential` is usable with no exchange and no refresh. */
function isCredentialReady(
  credential?: AuthCredential,
): credential is AuthCredential {
  return !!credential && READY_CREDENTIAL_TYPES.has(credential.authType);
}

/**
 * Rejects a scheme and raw credential that cannot work together.
 *
 * @throws If the scheme needs a raw credential and has none, or if an OAuth2
 *   raw credential carries no `oauth2` block.
 */
function validateCredential(authConfig: AuthConfig): void {
  const rawCredential = authConfig.rawAuthCredential;
  const schemeType = authConfig.authScheme.type;

  if (!rawCredential) {
    if (RAW_CREDENTIAL_REQUIRED_SCHEME_TYPES.has(schemeType)) {
      throw new Error(
        `rawAuthCredential is required for auth scheme type ${schemeType}`,
      );
    }
    return;
  }

  if (
    OAUTH2_CREDENTIAL_TYPES.has(rawCredential.authType) &&
    !rawCredential.oauth2
  ) {
    throw new Error(
      'authConfig.rawAuthCredential.oauth2 required for credential type ' +
        rawCredential.authType,
    );
  }
}
