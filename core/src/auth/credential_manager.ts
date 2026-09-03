/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {ServiceAccountCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {experimental} from '../utils/experimental.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from './exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';

/** The result of the refresh step. */
interface RefreshResult {
  credential: AuthCredential;
  wasRefreshed: boolean;
}

/** The credential types the OAuth2 flows produce. */
const OAUTH_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
];

/** The scheme types that cannot authenticate without a raw credential. */
const OAUTH_SCHEME_TYPES: readonly string[] = ['oauth2', 'openIdConnect'];

/** The grant type name an OpenID Connect scheme lists for client credentials. */
const CLIENT_CREDENTIALS_GRANT_TYPE = 'client_credentials';

/**
 * Whether the credential can be used as it stands, with no exchange or
 * refresh.
 */
function isCredentialReady(credential: AuthCredential): boolean {
  return (
    credential.authType === AuthCredentialTypes.API_KEY ||
    credential.authType === AuthCredentialTypes.HTTP
  );
}

/**
 * Whether the scheme authenticates the client itself rather than an end user.
 *
 * Such a scheme needs no consent round trip, so the raw credential the tool
 * was configured with is enough to start the exchange.
 */
function isClientCredentialsFlow(scheme: AuthScheme): boolean {
  if (scheme.type === 'oauth2') {
    return scheme.flows.clientCredentials !== undefined;
  }
  if (scheme.type === 'openIdConnect' && 'grantTypesSupported' in scheme) {
    return (
      scheme.grantTypesSupported?.includes(CLIENT_CREDENTIALS_GRANT_TYPE) ??
      false
    );
  }
  return false;
}

/**
 * Whether an OAuth2 scheme declares a flow whose required URL is empty.
 *
 * Each declared flow carries the endpoints that flow needs. A flow that is not
 * declared at all is not missing anything.
 */
function missingOAuthInfo(scheme: AuthScheme): boolean {
  if (scheme.type !== 'oauth2') {
    return false;
  }
  const {implicit, password, clientCredentials, authorizationCode} =
    scheme.flows;
  const requiredUrls: Array<string | undefined> = [
    ...(implicit ? [implicit.authorizationUrl] : []),
    ...(password ? [password.tokenUrl] : []),
    ...(clientCredentials ? [clientCredentials.tokenUrl] : []),
    ...(authorizationCode
      ? [authorizationCode.authorizationUrl, authorizationCode.tokenUrl]
      : []),
  ];
  return requiredUrls.some((url) => !url);
}

/**
 * Manages authentication credentials through a structured workflow.
 *
 * The manager owns the whole life cycle of a tool's credential: it validates
 * the configuration, loads a stored credential, reads the client's auth
 * response, exchanges or refreshes what it finds, and writes the result back
 * to the credential service. A caller that gets `undefined` back has to ask
 * the client to run the consent flow.
 *
 * This class is only for use by the Agent Development Kit.
 *
 * @example
 * ```ts
 * const manager = new CredentialManager({
 *   authScheme,
 *   rawAuthCredential,
 *   credentialKey: 'my_tool',
 * });
 * const credential = await manager.getAuthCredential(toolContext);
 * ```
 */
@experimental
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
   * Registers a credential exchanger for a credential type, replacing the
   * default one when there is one.
   *
   * @param credentialType The credential type to register for.
   * @param exchanger The exchanger to register.
   */
  registerCredentialExchanger(
    credentialType: AuthCredentialTypes,
    exchanger: BaseCredentialExchanger,
  ): void {
    this.exchangerRegistry.register(credentialType, exchanger);
  }

  /**
   * Asks the client to collect a credential for this tool.
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
   * @return The credential to call the API with, or `undefined` when the
   *     client still has to authorize one.
   */
  async getAuthCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    this.validateCredential();

    const rawAuthCredential = this.authConfig.rawAuthCredential;

    // A copy, because the exchange and refresh steps below mutate the
    // credential in place and tools share a long-lived auth config.
    if (rawAuthCredential && isCredentialReady(rawAuthCredential)) {
      return structuredClone(rawAuthCredential);
    }

    // A service account credential is minted per call and is never cached.
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
      if (
        !isClientCredentialsFlow(this.authConfig.authScheme) ||
        !rawAuthCredential
      ) {
        return undefined;
      }
      credential = structuredClone(rawAuthCredential);
    }

    const exchanged = await this.exchangeCredential(credential);
    let wasRefreshed = false;
    credential = exchanged.credential;
    if (!exchanged.wasExchanged) {
      const refreshed = await this.refreshCredential(credential);
      credential = refreshed.credential;
      wasRefreshed = refreshed.wasRefreshed;
    }

    const wasModified =
      wasFromAuthResponse || exchanged.wasExchanged || wasRefreshed;
    if (wasModified && !isServiceAccount) {
      await this.saveCredential(context, credential);
    }

    return credential;
  }

  private validateCredential(): void {
    const {authScheme, rawAuthCredential} = this.authConfig;

    if (!rawAuthCredential && OAUTH_SCHEME_TYPES.includes(authScheme.type)) {
      throw new Error(
        `raw_auth_credential is required for auth_scheme type ${authScheme.type}`,
      );
    }

    if (
      rawAuthCredential &&
      OAUTH_CREDENTIAL_TYPES.includes(rawAuthCredential.authType) &&
      !rawAuthCredential.oauth2
    ) {
      throw new Error(
        `auth_config.raw_credential.oauth2 required for credential type ${rawAuthCredential.authType}`,
      );
    }

    if (missingOAuthInfo(authScheme)) {
      throw new Error(
        'OAuth scheme info is missing, and auto-discovery has failed to fill them in.',
      );
    }
  }

  private async loadFromCredentialService(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialService = context.invocationContext.credentialService;
    return credentialService?.loadCredential(this.authConfig, context);
  }

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

  private async refreshCredential(
    credential: AuthCredential,
  ): Promise<RefreshResult> {
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

  private async saveCredential(
    context: Context,
    credential: AuthCredential,
  ): Promise<void> {
    const credentialService = context.invocationContext.credentialService;
    if (!credentialService) {
      return;
    }
    // A copy, so one user's exchanged credential never lands on the auth
    // config another invocation reads.
    const authConfigToSave: AuthConfig = {
      ...structuredClone(this.authConfig),
      exchangedAuthCredential: credential,
    };
    await credentialService.saveCredential(authConfigToSave, context);
  }
}
