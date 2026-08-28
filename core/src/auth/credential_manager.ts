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
import {AuthScheme, OAuthGrantType} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
import {
  determineGrantType,
  OAuth2CredentialExchanger,
} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {BaseCredentialRefresher} from './refresher/base_credential_refresher.js';

const OAUTH2_EXCHANGER = new OAuth2CredentialExchanger();
const OAUTH2_REFRESHER = new OAuth2CredentialRefresher();

/** The refresher for each credential type that can expire. */
const REFRESHERS: Partial<
  Record<AuthCredentialTypes, BaseCredentialRefresher>
> = {
  [AuthCredentialTypes.OAUTH2]: OAUTH2_REFRESHER,
  [AuthCredentialTypes.OPEN_ID_CONNECT]: OAUTH2_REFRESHER,
};

/** The exchanger for each credential type exchanged over the network. */
const EXCHANGERS: Partial<
  Record<AuthCredentialTypes, BaseCredentialExchanger>
> = {
  [AuthCredentialTypes.OAUTH2]: OAUTH2_EXCHANGER,
  [AuthCredentialTypes.OPEN_ID_CONNECT]: OAUTH2_EXCHANGER,
};

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
  /**
   * @param authConfig The scheme and the configured credential to resolve.
   */
  constructor(private readonly authConfig: AuthConfig) {}

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
    if (
      rawAuthCredential &&
      (rawAuthCredential.authType === AuthCredentialTypes.API_KEY ||
        rawAuthCredential.authType === AuthCredentialTypes.HTTP)
    ) {
      // A copy, because a long-lived tool shares one config across users.
      return cloneDeep(rawAuthCredential);
    }

    let credential =
      await context.invocationContext.credentialService?.loadCredential(
        this.authConfig,
        context,
      );
    let needsSave = false;
    if (!credential) {
      credential = context.getAuthResponse(this.authConfig);
      needsSave = credential !== undefined;
    }

    if (!credential) {
      // Validation guarantees a raw credential for the OAuth2 and OIDC schemes
      // a client-credentials flow can be declared on.
      const clientCredential =
        determineGrantType(this.authConfig.authScheme) ===
        OAuthGrantType.CLIENT_CREDENTIALS
          ? this.authConfig.rawAuthCredential
          : undefined;
      if (!clientCredential) {
        return undefined;
      }
      credential = cloneDeep(clientCredential);
    }

    const exchanged = await this.exchangeCredential(credential);
    credential = exchanged.credential;
    needsSave ||= exchanged.wasExchanged;
    if (!exchanged.wasExchanged) {
      const refreshed = await this.refreshCredential(credential);
      credential = refreshed.credential;
      needsSave ||= refreshed.wasRefreshed;
    }

    if (needsSave) {
      await this.saveCredential(context, credential);
    }
    return credential;
  }

  /** Rejects a configuration that cannot produce a credential. */
  private validateCredential(): void {
    const {authScheme, rawAuthCredential} = this.authConfig;
    if (
      !rawAuthCredential &&
      (authScheme.type === 'oauth2' || authScheme.type === 'openIdConnect')
    ) {
      throw new Error(
        `rawAuthCredential is required for authScheme type ${authScheme.type}.`,
      );
    }
    if (
      rawAuthCredential &&
      (rawAuthCredential.authType === AuthCredentialTypes.OAUTH2 ||
        rawAuthCredential.authType === AuthCredentialTypes.OPEN_ID_CONNECT) &&
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

  /** Exchanges the credential when a exchanger is registered for its type. */
  private async exchangeCredential(
    credential: AuthCredential,
  ): Promise<ExchangeResult> {
    // The service account exchanger is built here, not at module scope: its
    // @experimental constructor must not warn on import.
    const exchanger =
      credential.authType === AuthCredentialTypes.SERVICE_ACCOUNT
        ? new ServiceAccountCredentialExchanger()
        : EXCHANGERS[credential.authType];
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
    const refresher = REFRESHERS[credential.authType];
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
    await context.invocationContext.credentialService?.saveCredential(
      {...this.authConfig, exchangedAuthCredential: credential},
      context,
    );
  }
}
