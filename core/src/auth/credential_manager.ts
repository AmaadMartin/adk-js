/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme, OAuthGrantType} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {ExchangeResult} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/** Auth scheme types whose credentials are obtained through an OAuth2 flow. */
const OAUTH_SCHEME_TYPES: readonly string[] = ['oauth2', 'openIdConnect'];

/** Credential types whose payload lives under {@link AuthCredential.oauth2}. */
const OAUTH_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
];

/** Credential types that are usable as-is, with no exchange or refresh. */
const READY_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.API_KEY,
  AuthCredentialTypes.HTTP,
];

/** The result of a refresh attempt. */
interface RefreshResult {
  credential: AuthCredential;
  wasRefreshed: boolean;
}

/**
 * Whether the scheme drives a two-legged client-credentials flow, in which the
 * configured credential is sufficient and no end user has to sign in.
 */
function isClientCredentialsFlow(authScheme: AuthScheme): boolean {
  if (authScheme.type === 'oauth2') {
    return authScheme.flows?.clientCredentials !== undefined;
  }

  if (authScheme.type !== 'openIdConnect') {
    return false;
  }

  const grantTypes =
    'grantTypesSupported' in authScheme
      ? authScheme.grantTypesSupported
      : undefined;

  return grantTypes?.includes(OAuthGrantType.CLIENT_CREDENTIALS) ?? false;
}

/**
 * Rejects auth configs that can never resolve to a usable credential.
 *
 * @throws {Error} If the configured scheme needs a raw credential that is
 *     missing, or the raw credential is missing its OAuth2 payload.
 */
function validateAuthConfig(authConfig: AuthConfig): void {
  const rawAuthCredential = authConfig.rawAuthCredential;

  if (!rawAuthCredential) {
    if (OAUTH_SCHEME_TYPES.includes(authConfig.authScheme.type)) {
      throw new Error(
        `rawAuthCredential is required for auth scheme type ${authConfig.authScheme.type}`,
      );
    }
    return;
  }

  if (
    OAUTH_CREDENTIAL_TYPES.includes(rawAuthCredential.authType) &&
    !rawAuthCredential.oauth2
  ) {
    throw new Error(
      `rawAuthCredential.oauth2 is required for credential type ${rawAuthCredential.authType}`,
    );
  }
}

/**
 * Manages authentication credentials through a structured workflow: validate,
 * load, exchange, refresh and cache.
 *
 * This class is only for use by the Agent Development Kit.
 *
 * @experimental  (Experimental, subject to change)
 */
export class CredentialManager {
  private readonly exchangerRegistry = new CredentialExchangerRegistry();
  private readonly refresherRegistry = new CredentialRefresherRegistry();

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
   * Asks the client to collect a credential for the current tool call.
   *
   * @param toolContext The context of the tool call requesting the credential.
   * @throws {Error} If the context has no function call id to attach the
   *     request to.
   */
  async requestCredential(toolContext: Context): Promise<void> {
    toolContext.requestCredential(this.authConfig);
  }

  /**
   * Resolves a ready-to-use credential.
   *
   * @param toolContext The context of the tool call needing the credential.
   * @returns The credential, or `undefined` when the client must supply one
   *     before the tool can run.
   */
  async getAuthCredential(
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    validateAuthConfig(this.authConfig);

    const rawAuthCredential = this.authConfig.rawAuthCredential;
    if (
      rawAuthCredential &&
      READY_CREDENTIAL_TYPES.includes(rawAuthCredential.authType)
    ) {
      // Copied so a later exchange or refresh cannot mutate an AuthConfig that
      // the caller shares across invocations and users.
      return cloneDeep(rawAuthCredential);
    }

    const credentialService = toolContext.invocationContext.credentialService;
    let credential = await credentialService?.loadCredential(
      this.authConfig,
      toolContext,
    );

    // A credential the credential service does not hold yet has to be saved
    // once it has been resolved.
    let isUnsaved = false;
    if (!credential) {
      credential = toolContext.getAuthResponse(this.authConfig);
      isUnsaved = true;
    }

    if (!credential) {
      if (
        !rawAuthCredential ||
        !isClientCredentialsFlow(this.authConfig.authScheme)
      ) {
        return undefined;
      }
      credential = cloneDeep(rawAuthCredential);
    }

    const exchanged = await this.exchange(credential);
    credential = exchanged.credential;

    let wasRefreshed = false;
    if (!exchanged.wasExchanged) {
      const refreshed = await this.refresh(credential);
      credential = refreshed.credential;
      wasRefreshed = refreshed.wasRefreshed;
    }

    if (isUnsaved || exchanged.wasExchanged || wasRefreshed) {
      await credentialService?.saveCredential(
        {...this.authConfig, exchangedAuthCredential: credential},
        toolContext,
      );
    }

    return credential;
  }

  private async exchange(credential: AuthCredential): Promise<ExchangeResult> {
    const exchanger = this.exchangerRegistry.getExchanger(credential.authType);
    if (!exchanger) {
      return {credential, wasExchanged: false};
    }

    return exchanger.exchange({
      authCredential: credential,
      authScheme: this.authConfig.authScheme,
    });
  }

  private async refresh(credential: AuthCredential): Promise<RefreshResult> {
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
}
