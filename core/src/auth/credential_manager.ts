/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';
import {AutoAuthCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {experimental} from '../utils/experimental.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme, OAuthGrantType} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {ExchangeResult} from './exchanger/base_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {BaseCredentialRefresher} from './refresher/base_credential_refresher.js';

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
  if (authScheme.type === 'oauth2') {
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
  if (authScheme.type !== 'oauth2') {
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
 * @throws Error if the config is incomplete.
 */
function validateAuthConfig(authConfig: AuthConfig): void {
  const {authScheme, rawAuthCredential} = authConfig;

  if (!rawAuthCredential) {
    if (authScheme.type === 'oauth2' || authScheme.type === 'openIdConnect') {
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
      `authConfig.rawAuthCredential.oauth2 is required for credential type ${rawAuthCredential.authType}`,
    );
  }

  const missingUrl = missingOAuth2FlowUrl(authScheme);
  if (missingUrl) {
    throw new Error(
      `authConfig.authScheme.${missingUrl} is required for the declared OAuth2 flow`,
    );
  }
}

/** Renews an expired credential, when the type can expire. */
async function refreshCredential(
  credential: AuthCredential,
  authScheme: AuthScheme,
): Promise<ExchangeResult> {
  if (
    credential.authType !== AuthCredentialTypes.OAUTH2 &&
    credential.authType !== AuthCredentialTypes.OPEN_ID_CONNECT
  ) {
    return {credential, wasExchanged: false};
  }
  // Typed as the interface, so both calls pass the scheme the contract
  // declares rather than binding to what this refresher happens to read.
  const refresher: BaseCredentialRefresher = new OAuth2CredentialRefresher();
  if (!(await refresher.isRefreshNeeded(credential, authScheme))) {
    return {credential, wasExchanged: false};
  }
  return {
    credential: await refresher.refresh(credential, authScheme),
    wasExchanged: true,
  };
}

/**
 * Resolves the credential an authenticated tool runs with.
 *
 * One manager serves one {@link AuthConfig}. It reads a stored credential,
 * falls back to the answer the client sent back from a consent flow, exchanges
 * or refreshes it when the scheme requires that, and saves the result. When
 * nothing yields a credential the tool asks the client for one and the
 * invocation pauses.
 *
 * The manager keeps no per-call state, so one instance serves concurrent calls
 * from different users. Anything it would mutate it copies first.
 */
@experimental
export class CredentialManager {
  constructor(private readonly authConfig: AuthConfig) {}

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
    validateAuthConfig(this.authConfig);

    const {authScheme, rawAuthCredential} = this.authConfig;
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

    const exchanged = await new AutoAuthCredentialExchanger().exchange({
      authCredential: credential,
      authScheme,
    });
    // An exchange already produces a fresh token, so a refresh on top of it
    // would spend a second round trip for nothing.
    const resolved = exchanged.wasExchanged
      ? exchanged
      : await refreshCredential(exchanged.credential, authScheme);

    if ((fromAuthResponse || resolved.wasExchanged) && !isServiceAccount) {
      await credentialService?.saveCredential(
        {...this.authConfig, exchangedAuthCredential: resolved.credential},
        context,
      );
    }

    return resolved.credential;
  }
}
