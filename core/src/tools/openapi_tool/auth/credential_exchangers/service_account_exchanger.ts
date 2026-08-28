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
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {formatError} from '../../../../utils/error_utils.js';
import {experimental} from '../../../../utils/experimental.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Header that names the project Google APIs bill the call against.
 * Application Default Credentials often belong to a project other than the
 * caller's, so the exchange states the project explicitly.
 */
const QUOTA_PROJECT_HEADER = 'x-goog-user-project';

/** Shared by the two access-token paths; the ID-token path has its own. */
const ACCESS_TOKEN_FAILURE = 'Failed to exchange service account token';

/**
 * Builds the HTTP bearer credential the exchange returns.
 *
 * `additionalHeaders` stays absent unless a quota project resolved, so a caller
 * can tell "no project" from "an empty header set".
 */
function bearerResult(token: string, quotaProjectId?: string): ExchangeResult {
  return {
    credential: {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token},
        ...(quotaProjectId
          ? {additionalHeaders: {[QUOTA_PROJECT_HEADER]: quotaProjectId}}
          : {}),
      },
    },
    wasExchanged: true,
  };
}

/** Returns the explicit key material, or throws when the caller omitted it. */
function requireExplicitCredential(
  saConfig: ServiceAccount,
): ServiceAccountCredential {
  if (!saConfig.serviceAccountCredential) {
    throw new CredentialExchangeError(
      'Service account credentials are missing. serviceAccountCredential is ' +
        'required when useDefaultCredential is false.',
    );
  }
  return saConfig.serviceAccountCredential;
}

/**
 * Returns the project Application Default Credentials resolve to, or
 * `undefined` when the environment declares none. `getProjectId` rejects
 * instead of returning null, and a missing project is not a failure here.
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

async function exchangeAdcAccessToken(
  saConfig: ServiceAccount,
): Promise<ExchangeResult> {
  try {
    const auth = new GoogleAuth({
      scopes: saConfig.scopes?.length ? saConfig.scopes : DEFAULT_SCOPES,
    });
    const client = await auth.getClient();
    const {token} = await client.getAccessToken();

    if (!token) {
      throw new Error('Failed to get access token from default credentials');
    }

    const quotaProjectId =
      client.quotaProjectId ?? (await resolveAdcProjectId(auth));

    return bearerResult(token, quotaProjectId);
  } catch (error: unknown) {
    throw new CredentialExchangeError(
      `${ACCESS_TOKEN_FAILURE}: ${formatError(error)}`,
    );
  }
}

async function exchangeExplicitAccessToken(
  creds: ServiceAccountCredential,
  scopes: string[],
): Promise<ExchangeResult> {
  try {
    const client = new JWT({
      email: creds.clientEmail,
      key: creds.privateKey,
      scopes,
    });
    const {access_token: token} = await client.authorize();

    if (!token) {
      throw new Error('Failed to get access token from explicit credentials');
    }

    return bearerResult(token);
  } catch (error: unknown) {
    throw new CredentialExchangeError(
      `${ACCESS_TOKEN_FAILURE}: ${formatError(error)}`,
    );
  }
}

async function exchangeForAccessToken(
  saConfig: ServiceAccount,
): Promise<ExchangeResult> {
  if (saConfig.useDefaultCredential) {
    return exchangeAdcAccessToken(saConfig);
  }

  const creds = requireExplicitCredential(saConfig);
  if (!saConfig.scopes?.length) {
    throw new CredentialExchangeError(
      'scopes are required when using explicit service account credentials ' +
        'for access token exchange.',
    );
  }

  return exchangeExplicitAccessToken(creds, saConfig.scopes);
}

async function fetchAdcIdToken(audience: string): Promise<string> {
  const client = await new GoogleAuth().getIdTokenClient(audience);
  return client.idTokenProvider.fetchIdToken(audience);
}

async function exchangeForIdToken(
  saConfig: ServiceAccount,
): Promise<ExchangeResult> {
  const {audience} = saConfig;
  if (!audience) {
    throw new CredentialExchangeError(
      'audience is required when useIdToken is true. Set it to the URL of ' +
        'the target service (e.g. https://my-service.run.app).',
    );
  }

  const creds = saConfig.useDefaultCredential
    ? undefined
    : requireExplicitCredential(saConfig);

  try {
    const token = creds
      ? await new JWT({
          email: creds.clientEmail,
          key: creds.privateKey,
        }).fetchIdToken(audience)
      : await fetchAdcIdToken(audience);

    return bearerResult(token);
  } catch (error: unknown) {
    throw new CredentialExchangeError(
      `Failed to exchange service account for ID token: ${formatError(error)}`,
    );
  }
}

/**
 * Fetches credentials for Google Service Account.
 * Ported from Python implementation.
 *
 * The exchange mints an access token by default. When `useIdToken` is set, it
 * mints an ID token for `audience` instead. Backends that verify caller
 * identity, such as Cloud Run and Cloud Functions, require an ID token.
 *
 * On the access-token path, Application Default Credentials also carry the
 * `x-goog-user-project` header, so Google APIs bill the intended project.
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
      throw new CredentialExchangeError(
        'Service account credentials are missing. Please provide them, or set ' +
          '`useDefaultCredential = true` to use application default credential ' +
          'in a hosted service like Cloud Run.',
      );
    }

    const saConfig = authCredential.serviceAccount;

    return saConfig.useIdToken
      ? exchangeForIdToken(saConfig)
      : exchangeForAccessToken(saConfig);
  }
}
