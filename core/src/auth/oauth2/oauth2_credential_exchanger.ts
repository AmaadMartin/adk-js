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
  isOAuth2EndpointNotAllowedError,
  parseAuthorizationCode,
} from './oauth2_utils.js';

/**
 * Exchanges OAuth2 credentials from authorization responses using standard fetch.
 */
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  /**
   * Exchanges an OAuth2 credential from an authorization response.
   *
   * When the exchange cannot be completed, the original credential is returned
   * with `wasExchanged: false` and the reason is logged. This matches
   * adk-python, where a token endpoint failure degrades instead of aborting the
   * invocation. A configuration or tampering signal still throws, because no
   * retry can make it safe.
   *
   * @throws CredentialExchangeError If `authScheme` is missing, or if the
   *     `state` in the authorization response does not match the expected one.
   * @throws OAuth2EndpointNotAllowedError If the SSRF guard rejects the token
   *     endpoint.
   */
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
      return notExchanged(authCredential);
    }

    const grantType = determineGrantType(authScheme);

    if (grantType === OAuthGrantType.CLIENT_CREDENTIALS) {
      return exchangeClientCredentials({authCredential, authScheme});
    }

    if (grantType === OAuthGrantType.AUTHORIZATION_CODE) {
      return exchangeAuthorizationCode({authCredential, authScheme});
    }

    logger.warn(`Unsupported OAuth2 grant type: ${grantType}`);
    return notExchanged(authCredential);
  }
}

/** Returns the original credential unchanged. */
function notExchanged(authCredential: AuthCredential): ExchangeResult {
  return {credential: authCredential, wasExchanged: false};
}

export function determineGrantType(
  authScheme: AuthScheme,
): OAuthGrantType | undefined {
  if ('flows' in authScheme && authScheme.flows) {
    return getOAuthGrantTypeFromFlow(authScheme.flows);
  }

  if ((authScheme as OpenIdConnectWithConfig).grantTypesSupported) {
    const oidcScheme = authScheme as OpenIdConnectWithConfig;

    if (oidcScheme.grantTypesSupported?.includes('client_credentials')) {
      return OAuthGrantType.CLIENT_CREDENTIALS;
    }

    return OAuthGrantType.AUTHORIZATION_CODE;
  }
  return undefined;
}

/**
 * Exchanges a client id and secret for an access token.
 *
 * Returns the original credential with `wasExchanged: false` when the exchange
 * cannot be completed.
 *
 * @throws OAuth2EndpointNotAllowedError If the SSRF guard rejects the token
 *     endpoint.
 */
export async function exchangeClientCredentials({
  authCredential,
  authScheme,
}: {
  authCredential: AuthCredential;
  authScheme: AuthScheme;
}): Promise<ExchangeResult> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  if (!tokenEndpoint) {
    logger.warn(
      'Could not create OAuth2 session for client credentials exchange: token endpoint not found in auth scheme.',
    );
    return notExchanged(authCredential);
  }

  if (
    !authCredential.oauth2?.clientId ||
    !authCredential.oauth2?.clientSecret
  ) {
    logger.warn(
      'Could not create OAuth2 session for client credentials exchange: clientId and clientSecret are required.',
    );
    return notExchanged(authCredential);
  }

  const body = createOAuth2TokenRequestBody({
    grantType: 'client_credentials',
    clientId: authCredential.oauth2.clientId,
    clientSecret: authCredential.oauth2.clientSecret,
  });

  try {
    const oauth2Auth = await fetchOAuth2Tokens(tokenEndpoint, body);

    return {
      credential: {
        ...authCredential,
        oauth2: {
          ...authCredential.oauth2,
          ...oauth2Auth,
        },
      },
      wasExchanged: true,
    };
  } catch (error: unknown) {
    if (isOAuth2EndpointNotAllowedError(error)) {
      throw error;
    }
    // fetchOAuth2Tokens already logged the failure with its endpoint context.
    return notExchanged(authCredential);
  }
}

/**
 * Exchanges an authorization code for an access token.
 *
 * Returns the original credential with `wasExchanged: false` when the exchange
 * cannot be completed.
 *
 * @throws CredentialExchangeError If the `state` in the authorization response
 *     does not match the expected one.
 * @throws OAuth2EndpointNotAllowedError If the SSRF guard rejects the token
 *     endpoint.
 */
export async function exchangeAuthorizationCode({
  authCredential,
  authScheme,
}: {
  authCredential: AuthCredential;
  authScheme: AuthScheme;
}): Promise<ExchangeResult> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  if (!tokenEndpoint) {
    logger.warn(
      'Could not create OAuth2 session for authorization code exchange: token endpoint not found in auth scheme.',
    );
    return notExchanged(authCredential);
  }

  if (
    !authCredential.oauth2?.clientId ||
    !authCredential.oauth2?.clientSecret ||
    (!authCredential.oauth2?.authCode &&
      !authCredential.oauth2?.authResponseUri)
  ) {
    logger.warn(
      'Could not create OAuth2 session for authorization code exchange: clientId, clientSecret, and either authCode or authResponseUri are required.',
    );
    return notExchanged(authCredential);
  }

  let code = authCredential.oauth2.authCode;
  if (!code && authCredential.oauth2.authResponseUri) {
    code = parseAuthorizationCode(authCredential.oauth2.authResponseUri);
  }

  if (authCredential.oauth2.authResponseUri && authCredential.oauth2.state) {
    let receivedState: string | undefined;
    try {
      const url = new URL(authCredential.oauth2.authResponseUri);
      receivedState = url.searchParams.get('state') || undefined;
    } catch (error: unknown) {
      logger.warn(
        `Failed to parse authResponseUri for state validation: ${error instanceof Error ? error.message : String(error)}`,
      );
      return notExchanged(authCredential);
    }

    // Compared outside the `try` so a detected mismatch is reported as the
    // tampering signal it is, rather than caught and rewrapped as a parse
    // failure.
    if (authCredential.oauth2.state !== receivedState) {
      throw new CredentialExchangeError(
        'State mismatch detected. Potential CSRF attack.',
      );
    }
  }

  if (!code) {
    logger.warn('Authorization code not found in auth response.');
    return notExchanged(authCredential);
  }

  const body = createOAuth2TokenRequestBody({
    grantType: 'authorization_code',
    clientId: authCredential.oauth2.clientId,
    clientSecret: authCredential.oauth2.clientSecret,
    code,
    redirectUri: authCredential.oauth2.redirectUri,
    codeVerifier: authCredential.oauth2.codeVerifier,
  });

  try {
    const oauth2Auth = await fetchOAuth2Tokens(tokenEndpoint, body);

    return {
      credential: {
        ...authCredential,
        oauth2: {
          ...authCredential.oauth2,
          ...oauth2Auth,
        },
      },
      wasExchanged: true,
    };
  } catch (error: unknown) {
    if (isOAuth2EndpointNotAllowedError(error)) {
      throw error;
    }
    // fetchOAuth2Tokens already logged the failure with its endpoint context.
    return notExchanged(authCredential);
  }
}
