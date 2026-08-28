/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';
import {ServiceAccountCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {experimental} from '../utils/experimental.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {BaseCredentialExchanger} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {BaseCredentialRefresher} from './refresher/base_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/** Scheme types that cannot authenticate without a configured credential. */
const OAUTH_SCHEME_TYPES: ReadonlyArray<AuthScheme['type']> = [
  'oauth2',
  'openIdConnect',
];

/** Credential types whose secret lives in the `oauth2` field. */
const OAUTH_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
];

/** Whether a credential can be used as configured, with no exchange. */
function isCredentialReady(credential: AuthCredential): boolean {
  return (
    credential.authType === AuthCredentialTypes.API_KEY ||
    credential.authType === AuthCredentialTypes.HTTP
  );
}

/**
 * Names the OAuth2 flow URL the scheme declares a flow for but does not
 * supply, or `undefined` when the scheme is complete.
 */
function missingOAuthUrl(authScheme: AuthScheme): string | undefined {
  if (authScheme.type !== 'oauth2') {
    return undefined;
  }
  const {implicit, password, clientCredentials, authorizationCode} =
    authScheme.flows;
  if (implicit && !implicit.authorizationUrl) {
    return 'implicit.authorizationUrl';
  }
  if (password && !password.tokenUrl) {
    return 'password.tokenUrl';
  }
  if (clientCredentials && !clientCredentials.tokenUrl) {
    return 'clientCredentials.tokenUrl';
  }
  if (authorizationCode && !authorizationCode.authorizationUrl) {
    return 'authorizationCode.authorizationUrl';
  }
  if (authorizationCode && !authorizationCode.tokenUrl) {
    return 'authorizationCode.tokenUrl';
  }
  return undefined;
}

/**
 * Whether the scheme authenticates the client itself, so no end user has to
 * grant consent. Covers both OAuth2 and OpenID Connect schemes.
 */
function isClientCredentialsFlow(authScheme: AuthScheme): boolean {
  if (authScheme.type === 'oauth2') {
    return authScheme.flows.clientCredentials !== undefined;
  }
  if (
    authScheme.type === 'openIdConnect' &&
    'grantTypesSupported' in authScheme
  ) {
    return (
      authScheme.grantTypesSupported?.includes('client_credentials') ?? false
    );
  }
  return false;
}

/**
 * Resolves the credential a tool needs, through the whole lifecycle: validate
 * the configuration, return an already-usable credential as is, load a stored
 * one from the credential service, fall back to the auth response the client
 * sent back, exchange it, refresh it, and save the result.
 *
 * A tool holds one manager per {@link AuthConfig}. The manager keeps no
 * per-call state, so one instance serves concurrent calls from different users.
 *
 * @example
 * ```ts
 * const manager = new CredentialManager(authConfig);
 * const credential = await manager.getAuthCredential(toolContext);
 * if (!credential) {
 *   manager.requestCredential(toolContext);
 * }
 * ```
 */
@experimental
export class CredentialManager {
  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();

  /**
   * @param authConfig The scheme and the configured credential to resolve.
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
   * Registers an exchanger for a credential type on this manager, replacing
   * the default for that type.
   *
   * @param credentialType The credential type the exchanger handles.
   * @param exchanger The exchanger to use for that type.
   */
  registerCredentialExchanger(
    credentialType: AuthCredentialTypes,
    exchanger: BaseCredentialExchanger,
  ): void {
    this.exchangerRegistry.register(credentialType, exchanger);
  }

  /**
   * Registers a refresher for a credential type on this manager, replacing the
   * default for that type.
   *
   * @param credentialType The credential type the refresher handles.
   * @param refresher The refresher to use for that type.
   */
  registerCredentialRefresher(
    credentialType: AuthCredentialTypes,
    refresher: BaseCredentialRefresher,
  ): void {
    this.refresherRegistry.register(credentialType, refresher);
  }

  /**
   * Asks the client for a credential. The invocation pauses as a result: the
   * flow emits an `adk_request_credential` call and ends the turn.
   *
   * @param context The context of the tool call that needs the credential.
   */
  requestCredential(context: Context): void {
    context.requestCredential(this.authConfig);
  }

  /**
   * Resolves a ready-to-use credential.
   *
   * @param context The context of the tool call that needs the credential.
   * @returns The credential, or `undefined` when the end user must consent
   *   first.
   * @throws If the auth configuration cannot produce a credential.
   */
  async getAuthCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    this.validateCredential();

    const rawAuthCredential = this.authConfig.rawAuthCredential;
    if (rawAuthCredential && isCredentialReady(rawAuthCredential)) {
      // A copy, because a long-lived tool shares one config across users.
      return cloneDeep(rawAuthCredential);
    }

    let credential = await this.loadFromCredentialService(context);
    let wasFromAuthResponse = false;
    if (!credential) {
      credential = context.getAuthResponse(this.authConfig);
      wasFromAuthResponse = true;
    }

    if (!credential) {
      // Validation guarantees a raw credential for the OAuth2 and OIDC schemes
      // a client-credentials flow can be declared on.
      const clientCredential = isClientCredentialsFlow(
        this.authConfig.authScheme,
      )
        ? this.authConfig.rawAuthCredential
        : undefined;
      if (!clientCredential) {
        return undefined;
      }
      credential = cloneDeep(clientCredential);
    }

    const exchanged = await this.exchangeCredential(credential);
    let wasRefreshed = false;
    credential = exchanged.credential;
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

  /** Rejects a configuration that cannot produce a credential. */
  private validateCredential(): void {
    const {authScheme, rawAuthCredential} = this.authConfig;
    if (!rawAuthCredential && OAUTH_SCHEME_TYPES.includes(authScheme.type)) {
      throw new Error(
        `rawAuthCredential is required for authScheme type ${authScheme.type}.`,
      );
    }
    if (
      rawAuthCredential &&
      OAUTH_CREDENTIAL_TYPES.includes(rawAuthCredential.authType) &&
      !rawAuthCredential.oauth2
    ) {
      throw new Error(
        `rawAuthCredential.oauth2 is required for credential type ${rawAuthCredential.authType}.`,
      );
    }
    const missingUrl = missingOAuthUrl(authScheme);
    if (missingUrl) {
      throw new Error(`The OAuth scheme is missing ${missingUrl}.`);
    }
  }

  /** Reads the credential the credential service holds, when there is one. */
  private async loadFromCredentialService(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialService = context.invocationContext.credentialService;
    return credentialService?.loadCredential(this.authConfig, context);
  }

  /** Exchanges the credential when a exchanger is registered for its type. */
  private async exchangeCredential(
    credential: AuthCredential,
  ): Promise<{credential: AuthCredential; wasExchanged: boolean}> {
    const exchanger = this.exchangerRegistry.getExchanger(credential.authType);
    if (!exchanger) {
      return {credential, wasExchanged: false};
    }
    return exchanger.exchange({
      authCredential: credential,
      authScheme: this.authConfig.authScheme,
    });
  }

  /** Refreshes the credential when it has expired. */
  private async refreshCredential(
    credential: AuthCredential,
  ): Promise<{credential: AuthCredential; wasRefreshed: boolean}> {
    const refresher = this.refresherRegistry.getRefresher(credential.authType);
    if (!refresher) {
      return {credential, wasRefreshed: false};
    }
    if (
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

  /** Stores the credential so a later call resolves it without pausing. */
  private async saveCredential(
    context: Context,
    credential: AuthCredential,
  ): Promise<void> {
    const credentialService = context.invocationContext.credentialService;
    if (!credentialService) {
      return;
    }
    const authConfigToSave = cloneDeep(this.authConfig);
    authConfigToSave.exchangedAuthCredential = credential;
    await credentialService.saveCredential(authConfigToSave, context);
  }
}
