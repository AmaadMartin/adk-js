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
  ServiceAccountCredential,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  AuthCredentialMissingError,
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {InputValidationError} from '../../../../errors/input_validation_error.js';
import {formatError} from '../../../../utils/error_utils.js';
import {experimental} from '../../../../utils/experimental.js';
import {readJwtExpirySeconds} from '../../../../utils/jwt_utils.js';
import {
  cacheToken,
  defaultExpirySeconds,
  getCachedToken,
} from './token_cache.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const QUOTA_PROJECT_HEADER = 'x-goog-user-project';

const SERVICE_ACCOUNT_MISSING_MESSAGE =
  'Service account credentials are missing. Please provide them, or set ' +
  '`useDefaultCredential = true` to use application default credentials in ' +
  'a hosted service like Cloud Run.';
const ACCESS_TOKEN_CREDENTIAL_MISSING_MESSAGE =
  'Service account credentials are missing.';
const ID_TOKEN_CREDENTIAL_MISSING_MESSAGE =
  'serviceAccountCredential is required when useDefaultCredential is false.';
const AUDIENCE_REQUIRED_MESSAGE =
  'audience is required when useIdToken is true. Set it to the URL of the ' +
  "target service (e.g. 'https://my-service.run.app').";
const SCOPES_REQUIRED_MESSAGE =
  'scopes are required when using explicit service account credentials for ' +
  'access token exchange.';

function bearerCredential(
  token: string,
  quotaProjectId?: string,
): AuthCredential {
  return {
    authType: AuthCredentialTypes.HTTP,
    http: {
      scheme: 'bearer',
      credentials: {token},
      ...(quotaProjectId
        ? {additionalHeaders: {[QUOTA_PROJECT_HEADER]: quotaProjectId}}
        : {}),
    },
  };
}

/**
 * Resolves the project id of the ambient credentials, or `undefined` when the
 * environment has none. `getProjectId` rejects in that case, where the Python
 * reference's `google.auth.default()` simply reports no project.
 */
async function resolveAdcProjectId(
  auth: GoogleAuth,
): Promise<string | undefined> {
  try {
    return await auth.getProjectId();
  } catch {
    return undefined;
  }
}

async function fetchAdcIdToken(audience: string): Promise<string> {
  const client = await new GoogleAuth().getIdTokenClient(audience);
  return client.idTokenProvider.fetchIdToken(audience);
}

function fetchExplicitIdToken(
  creds: ServiceAccountCredential,
  audience: string,
): Promise<string> {
  const jwt = new JWT({email: creds.clientEmail, key: creds.privateKey});
  return jwt.fetchIdToken(audience);
}

/**
 * Fetches credentials for Google Service Account.
 *
 * Uses application default credentials when `useDefaultCredential` is true,
 * and the service account key in the credential otherwise. Mints an ID token
 * instead of an access token when `useIdToken` is true, which is what Cloud
 * Run, Cloud Functions, and other services that verify caller identity expect.
 *
 * Ported from the Python implementation.
 */
@experimental
export class ServiceAccountCredentialExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential} = params;

    if (authCredential.authType !== AuthCredentialTypes.SERVICE_ACCOUNT) {
      throw new CredentialExchangeError(
        'Invalid credential type for ServiceAccountCredentialExchanger',
      );
    }
    if (!authCredential.serviceAccount) {
      throw new AuthCredentialMissingError(SERVICE_ACCOUNT_MISSING_MESSAGE);
    }

    const saConfig = authCredential.serviceAccount;

    if (saConfig.useIdToken) {
      return this.exchangeForIdToken(saConfig);
    }

    return this.exchangeForAccessToken(saConfig);
  }

  private async exchangeForIdToken(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    const audience = saConfig.audience;
    if (!audience) {
      throw new InputValidationError(AUDIENCE_REQUIRED_MESSAGE);
    }
    const useAdc = saConfig.useDefaultCredential === true;
    const creds = useAdc ? undefined : saConfig.serviceAccountCredential;
    if (!useAdc && !creds) {
      throw new AuthCredentialMissingError(ID_TOKEN_CREDENTIAL_MISSING_MESSAGE);
    }

    const cached = getCachedToken(saConfig);
    if (cached) {
      return {credential: cached, wasExchanged: true};
    }

    let token: string;
    try {
      token = creds
        ? await fetchExplicitIdToken(creds, audience)
        : await fetchAdcIdToken(audience);
    } catch (error: unknown) {
      throw new AuthCredentialMissingError(
        `Failed to exchange service account for ID token: ${formatError(error)}`,
      );
    }

    const credential = bearerCredential(token);
    cacheToken(
      saConfig,
      credential,
      readJwtExpirySeconds(token) ?? defaultExpirySeconds(),
    );
    return {credential, wasExchanged: true};
  }

  private async exchangeForAccessToken(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    // The credential check precedes the scopes check so that a configuration
    // missing both reports the more specific failure.
    const useAdc = saConfig.useDefaultCredential === true;
    const creds = useAdc ? undefined : saConfig.serviceAccountCredential;
    if (!useAdc && !creds) {
      throw new AuthCredentialMissingError(
        ACCESS_TOKEN_CREDENTIAL_MISSING_MESSAGE,
      );
    }
    if (creds && !saConfig.scopes?.length) {
      throw new AuthCredentialMissingError(SCOPES_REQUIRED_MESSAGE);
    }

    const cached = getCachedToken(saConfig);
    if (cached) {
      return {credential: cached, wasExchanged: true};
    }

    let token: string;
    let expiryDateMs: number | null | undefined;
    let quotaProjectId: string | undefined;
    try {
      if (creds) {
        const client = new JWT({
          email: creds.clientEmail,
          key: creds.privateKey,
          scopes: saConfig.scopes,
        });
        const tokens = await client.authorize();
        if (!tokens.access_token) {
          throw new Error(
            'Failed to get access token from explicit credentials',
          );
        }
        token = tokens.access_token;
        expiryDateMs = tokens.expiry_date;
      } else {
        const auth = new GoogleAuth({
          scopes: saConfig.scopes?.length ? saConfig.scopes : DEFAULT_SCOPES,
        });
        const client = await auth.getClient();
        const response = await client.getAccessToken();
        if (!response.token) {
          throw new Error(
            'Failed to get access token from default credentials',
          );
        }
        token = response.token;
        expiryDateMs = client.credentials?.expiry_date;
        // `||`, not `??`: an empty quota project falls back to the ADC
        // project, as the reference's `or` does.
        quotaProjectId =
          client.quotaProjectId || (await resolveAdcProjectId(auth));
      }
    } catch (error: unknown) {
      throw new AuthCredentialMissingError(
        `Failed to exchange service account token: ${formatError(error)}`,
      );
    }

    const credential = bearerCredential(token, quotaProjectId);
    cacheToken(
      saConfig,
      credential,
      typeof expiryDateMs === 'number'
        ? expiryDateMs / 1000
        : defaultExpirySeconds(),
    );
    return {credential, wasExchanged: true};
  }
}
