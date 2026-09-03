/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {AuthCredential} from '../auth_credential.js';
import {
  AuthScheme,
  getOAuthGrantTypeFromFlow,
  OAuthGrantType,
  OpenIdConnectWithConfig,
} from '../auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../exchanger/base_credential_exchanger.js';
import {
  createOAuth2TokenRequestBody,
  fetchOAuth2Tokens,
  getTokenEndpoint,
  normalizeAuthUri,
  parseAuthorizationCode,
} from './oauth2_utils.js';

/**
 * Exchanges OAuth2 credentials from authorization responses using standard fetch.
 *
 * An exchange that fails returns the original credential with
 * `wasExchanged: false`, so a caller can degrade to an unauthenticated call.
 * Only a missing `authScheme` and a state mismatch reject.
 *
 * There is no synchronous counterpart. The Python reference offers one because
 * a coroutine cannot be called from synchronous code; JavaScript cannot block
 * on a promise, and every caller here already awaits {@link exchange}.
 */
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  async exchange({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<ExchangeResult> {
    if (!authScheme) {
      throw new CredentialExchangeError(
        'authScheme is required for OAuth2 credential exchange',
      );
    }

    if (authCredential.oauth2?.accessToken) {
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    const grantType = determineGrantType(authScheme);

    if (grantType === OAuthGrantType.CLIENT_CREDENTIALS) {
      return exchangeClientCredentials({authCredential, authScheme});
    }

    if (grantType === OAuthGrantType.AUTHORIZATION_CODE) {
      return exchangeAuthorizationCode({authCredential, authScheme});
    }

    logger.warn(`Unsupported OAuth2 grant type: ${grantType}`);
    return {
      credential: authCredential,
      wasExchanged: false,
    };
  }
}

export function determineGrantType(
  authScheme: AuthScheme,
): OAuthGrantType | undefined {
  if ('flows' in authScheme && authScheme.flows) {
    return getOAuthGrantTypeFromFlow(authScheme.flows);
  }

  const oidcScheme = authScheme as OpenIdConnectWithConfig;
  if (authScheme.type === 'openIdConnect' || oidcScheme.grantTypesSupported) {
    return oidcScheme.grantTypesSupported?.includes('client_credentials')
      ? OAuthGrantType.CLIENT_CREDENTIALS
      : OAuthGrantType.AUTHORIZATION_CODE;
  }

  return undefined;
}

export async function exchangeClientCredentials({
  authCredential,
  authScheme,
}: {
  authCredential: AuthCredential;
  authScheme: AuthScheme;
}): Promise<ExchangeResult> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  const oauth2 = authCredential.oauth2;

  if (!tokenEndpoint || !oauth2?.clientId || !oauth2.clientSecret) {
    logger.warn(
      'Could not create OAuth2 session for client credentials exchange',
    );
    return {credential: authCredential, wasExchanged: false};
  }

  const body = createOAuth2TokenRequestBody({
    grantType: 'client_credentials',
    clientId: oauth2.clientId,
    clientSecret: oauth2.clientSecret,
  });

  try {
    const oauth2Auth = await fetchOAuth2Tokens(tokenEndpoint, body);
    logger.debug('Successfully exchanged client credentials for access token');

    return {
      credential: {
        ...authCredential,
        oauth2: {
          ...oauth2,
          ...oauth2Auth,
        },
      },
      wasExchanged: true,
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to exchange client credentials: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {credential: authCredential, wasExchanged: false};
  }
}

export async function exchangeAuthorizationCode({
  authCredential,
  authScheme,
}: {
  authCredential: AuthCredential;
  authScheme: AuthScheme;
}): Promise<ExchangeResult> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  const oauth2 = authCredential.oauth2;
  const authResponseUri = normalizeAuthUri(oauth2?.authResponseUri);

  if (
    !tokenEndpoint ||
    !oauth2?.clientId ||
    !oauth2.clientSecret ||
    (!oauth2.authCode && !authResponseUri)
  ) {
    logger.warn(
      'Could not create OAuth2 session for authorization code exchange',
    );
    return {credential: authCredential, wasExchanged: false};
  }

  let code = oauth2.authCode;
  if (!code && authResponseUri) {
    code = parseAuthorizationCode(authResponseUri);
  }

  if (authResponseUri && oauth2.state) {
    let receivedState: string | undefined;
    try {
      receivedState =
        new URL(authResponseUri).searchParams.get('state') ?? undefined;
    } catch (e: unknown) {
      throw new CredentialExchangeError(
        `Failed to parse authResponseUri for state validation: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (oauth2.state !== receivedState) {
      throw new CredentialExchangeError(
        'State mismatch detected. Potential CSRF attack.',
      );
    }
  }

  if (!code) {
    logger.warn('Authorization code not found in auth response.');
    return {credential: authCredential, wasExchanged: false};
  }

  const body = createOAuth2TokenRequestBody({
    grantType: 'authorization_code',
    clientId: oauth2.clientId,
    clientSecret: oauth2.clientSecret,
    code,
    redirectUri: oauth2.redirectUri,
    codeVerifier: oauth2.codeVerifier,
  });

  try {
    const oauth2Auth = await fetchOAuth2Tokens(tokenEndpoint, body);
    logger.debug('Successfully exchanged authorization code for access token');

    return {
      credential: {
        ...authCredential,
        oauth2: {
          ...oauth2,
          ...oauth2Auth,
        },
      },
      wasExchanged: true,
    };
  } catch (error: unknown) {
    logger.error(
      `Failed to exchange authorization code: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {credential: authCredential, wasExchanged: false};
  }
}
