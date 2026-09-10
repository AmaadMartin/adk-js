/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
// ServiceAccountCredentialExchanger belongs in `auth/exchanger/`; moving it out
// of the tools layer is deliberately out of scope for this change.
import {ServiceAccountCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {experimental} from '../utils/experimental.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/** The result of the refresh step. */
interface RefreshResult {
  credential: AuthCredential;
  wasRefreshed: boolean;
}

/** Auth scheme types whose credential can only come from the end user. */
const USER_CONSENT_SCHEME_TYPES: readonly string[] = ['oauth2', 'openIdConnect'];

/** Credential types that are usable as configured, with no exchange. */
const READY_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.API_KEY,
  AuthCredentialTypes.HTTP,
];

/** Credential types that carry an OAuth2 client configuration. */
const OAUTH2_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
];

/**
 * Rejects an `AuthConfig` that cannot produce a credential.
 *
 * @param authConfig The configuration to validate.
 * @throws If the scheme needs a raw credential and none is configured, or if an
 *     OAuth2 credential carries no OAuth2 client configuration.
 */
function validateCredential(authConfig: AuthConfig): void {
  const rawAuthCredential = authConfig.rawAuthCredential;

  if (!rawAuthCredential) {
    if (USER_CONSENT_SCHEME_TYPES.includes(authConfig.authScheme.type)) {
      throw new Error(
        `rawAuthCredential is required for auth scheme type ${authConfig.authScheme.type}`,
      );
    }
    return;
  }

  if (
    OAUTH2_CREDENTIAL_TYPES.includes(rawAuthCredential.authType) &&
    !rawAuthCredential.oauth2
  ) {
    throw new Error(
      `authConfig.rawAuthCredential.oauth2 is required for credential type ${rawAuthCredential.authType}`,
    );
  }
}

/** Whether the configured raw credential is usable without any processing. */
function isCredentialReady(authConfig: AuthConfig): boolean {
  const rawAuthCredential = authConfig.rawAuthCredential;

  return (
    !!rawAuthCredential &&
    READY_CREDENTIAL_TYPES.includes(rawAuthCredential.authType)
  );
}

/**
 * Manages authentication credentials through a structured workflow.
 *
 * `CredentialManager` orchestrates the lifecycle of an authentication
 * credential, from loading to preparation for use: validation, cache lookup,
 * pickup of an auth response, exchange, refresh and write-back. Tools such as
 * {@link BaseAuthenticatedTool} delegate to it rather than driving
 * `Context.getAuthResponse` and `Context.requestCredential` themselves.
 *
 * This class is experimental and its API may change without a major release.
 *
 * @example
 * ```ts
 * const manager = new CredentialManager(authConfig);
 * manager.registerCredentialExchanger(
 *   AuthCredentialTypes.SERVICE_ACCOUNT,
 *   new MyExchanger(),
 * );
 * const credential = await manager.getAuthCredential(toolContext);
 * ```
 */
@experimental
export class CredentialManager {
  private readonly authConfig: AuthConfig;
  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();

  /**
   * @param authConfig The auth scheme and credentials this manager resolves.
   */
  constructor(authConfig: AuthConfig) {
    this.authConfig = authConfig;

    this.exchangerRegistry.register(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new ServiceAccountCredentialExchanger(),
    );

    // No OAuth2 exchanger is registered: `AuthHandler.parseAndStoreAuthResponse`
    // already trades the authorization code for a token, so
    // `Context.getAuthResponse` hands back an exchanged credential.
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
   * Registers a credential exchanger for a credential type, replacing any
   * exchanger already registered for it.
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
   * Asks the client for the credential this manager is configured with.
   *
   * @param toolContext The context of the tool call that needs the credential.
   */
  async requestCredential(toolContext: Context): Promise<void> {
    toolContext.requestCredential(this.authConfig);
  }

  /**
   * Loads and prepares the authentication credential.
   *
   * @param toolContext The context of the tool call that needs the credential.
   * @return The ready-to-use credential, or `undefined` when none is available
   *     and the client has to supply one.
   */
  async getAuthCredential(
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    validateCredential(this.authConfig);

    if (isCredentialReady(this.authConfig)) {
      return this.authConfig.rawAuthCredential;
    }

    let credential = await this.loadExistingCredential(toolContext);

    let wasFromAuthResponse = false;
    if (!credential) {
      credential = toolContext.getAuthResponse(this.authConfig);
      wasFromAuthResponse = true;
    }

    if (!credential) {
      return undefined;
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
      await this.saveCredential(toolContext, credential);
    }

    return credential;
  }

  /**
   * Loads the credential a previous call stored, from the credential service
   * first and from the cached exchanged credential second.
   */
  private async loadExistingCredential(
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialService = toolContext.invocationContext.credentialService;
    const credential = await credentialService?.loadCredential(
      this.authConfig,
      toolContext,
    );

    return credential ?? this.authConfig.exchangedAuthCredential;
  }

  /** Exchanges the credential when an exchanger is registered for its type. */
  private async exchangeCredential(
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

  /** Refreshes the credential when its refresher reports it has expired. */
  private async refreshCredential(
    credential: AuthCredential,
  ): Promise<RefreshResult> {
    const refresher = this.refresherRegistry.getRefresher(credential.authType);
    if (
      !refresher ||
      !(await refresher.isRefreshNeeded(credential, this.authConfig.authScheme))
    ) {
      return {credential, wasRefreshed: false};
    }

    return {
      credential: await refresher.refresh(
        credential,
        this.authConfig.authScheme,
      ),
      wasRefreshed: true,
    };
  }

  /**
   * Writes the credential back to the credential service, so the next
   * invocation does not repeat the round trip. A run without a credential
   * service keeps the credential for this invocation only.
   */
  private async saveCredential(
    toolContext: Context,
    credential: AuthCredential,
  ): Promise<void> {
    const credentialService = toolContext.invocationContext.credentialService;
    if (!credentialService) {
      return;
    }

    this.authConfig.exchangedAuthCredential = credential;
    return credentialService.saveCredential(this.authConfig, toolContext);
  }
}
