/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

const AUDIENCE_REQUIRED_MESSAGE =
  'audience is required when useIdToken is true. Set it to the URL of the ' +
  'target service (e.g. https://my-service.run.app).';

function toBearerResult(token: string): ExchangeResult {
  return {
    credential: {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token},
      },
    },
    wasExchanged: true,
  };
}

/**
 * Fetches credentials for Google Service Account.
 * Ported from Python implementation.
 *
 * When `useIdToken` is set, the exchange returns an ID token minted for
 * `audience` instead of an access token. Backends that verify caller identity,
 * such as Cloud Run and Cloud Functions, require an ID token.
 */
@experimental
export class ServiceAccountCredentialExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential} = params;

    if (
      authCredential.authType !== AuthCredentialTypes.SERVICE_ACCOUNT ||
      !authCredential.serviceAccount
    ) {
      throw new CredentialExchangeError(
        'Invalid credential type for ServiceAccountCredentialExchanger',
      );
    }

    const saConfig = authCredential.serviceAccount;

    if (saConfig.useIdToken) {
      const {audience} = saConfig;
      if (!audience) {
        throw new CredentialExchangeError(AUDIENCE_REQUIRED_MESSAGE);
      }
      return saConfig.useDefaultCredential
        ? this.exchangeForDefaultIdToken(audience)
        : this.exchangeForExplicitIdToken(saConfig, audience);
    }

    if (saConfig.useDefaultCredential) {
      return this.exchangeForDefaultCredential(saConfig);
    }

    return this.exchangeForExplicitCredential(saConfig);
  }

  private async exchangeForDefaultCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    try {
      const auth = new GoogleAuth({
        scopes: saConfig.scopes || DEFAULT_SCOPES,
      });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const token = tokenResponse.token;

      if (!token) {
        throw new Error('Failed to get access token from default credentials');
      }

      return toBearerResult(token);
    } catch (error) {
      throw new CredentialExchangeError(
        `Failed to exchange default service account token: ${(error as Error).message}`,
      );
    }
  }

  private async exchangeForExplicitCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    const creds = saConfig.serviceAccountCredential;
    if (!creds) {
      throw new CredentialExchangeError(
        'Service account credentials are missing.',
      );
    }

    try {
      const client = new JWT({
        email: creds.clientEmail,
        key: creds.privateKey,
        scopes: saConfig.scopes,
      });

      const tokens = await client.authorize();
      const token = tokens.access_token;

      if (!token) {
        throw new Error('Failed to get access token from explicit credentials');
      }

      return toBearerResult(token);
    } catch (error) {
      throw new CredentialExchangeError(
        `Failed to exchange explicit service account token: ${(error as Error).message}`,
      );
    }
  }

  private async exchangeForDefaultIdToken(
    audience: string,
  ): Promise<ExchangeResult> {
    try {
      const auth = new GoogleAuth();
      const client = await auth.getIdTokenClient(audience);
      const token = await client.idTokenProvider.fetchIdToken(audience);

      return toBearerResult(token);
    } catch (error) {
      throw new CredentialExchangeError(
        `Failed to exchange service account for ID token: ${(error as Error).message}`,
      );
    }
  }

  private async exchangeForExplicitIdToken(
    saConfig: ServiceAccount,
    audience: string,
  ): Promise<ExchangeResult> {
    const creds = saConfig.serviceAccountCredential;
    if (!creds) {
      throw new CredentialExchangeError(
        'Service account credentials are missing.',
      );
    }

    try {
      const client = new JWT({
        email: creds.clientEmail,
        key: creds.privateKey,
      });

      const token = await client.fetchIdToken(audience);

      return toBearerResult(token);
    } catch (error) {
      throw new CredentialExchangeError(
        `Failed to exchange service account for ID token: ${(error as Error).message}`,
      );
    }
  }
}
