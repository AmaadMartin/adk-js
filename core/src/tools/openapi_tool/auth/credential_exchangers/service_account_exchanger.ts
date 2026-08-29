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

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const CACHE_EXPIRY_SKEW_SECONDS = 300;
const MAX_CACHED_TOKENS = 100;
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

interface CachedToken {
  credential: AuthCredential;
  expiresAtSeconds: number;
}

// One map, unlike the reference's two: `useIdToken` is part of the cache key.
const tokenCache = new Map<string, CachedToken>();

function nowSeconds(): number {
  return Date.now() / 1000;
}

/**
 * Builds the cache key for a service account configuration. Two configurations
 * share a token only when every field that changes the minted token matches.
 */
function cacheKey(saConfig: ServiceAccount): string {
  const creds = saConfig.serviceAccountCredential;
  return JSON.stringify([
    saConfig.useDefaultCredential === true,
    creds?.privateKeyId ?? null,
    creds?.clientEmail ?? null,
    saConfig.scopes ?? [],
    saConfig.useIdToken === true,
    saConfig.audience ?? null,
  ]);
}

/** Returns a cached credential that stays valid for the whole skew window. */
function getCachedCredential(key: string): AuthCredential | undefined {
  const cached = tokenCache.get(key);
  if (
    cached &&
    nowSeconds() < cached.expiresAtSeconds - CACHE_EXPIRY_SKEW_SECONDS
  ) {
    return cached.credential;
  }
  return undefined;
}

/**
 * Stores a credential, evicting the oldest entry once the cache is full. The
 * reference cache is unbounded; a long-running agent needs a cap.
 */
function setCachedCredential(
  key: string,
  credential: AuthCredential,
  expiresAtSeconds: number,
): void {
  tokenCache.delete(key);
  if (tokenCache.size >= MAX_CACHED_TOKENS) {
    // A Map iterates in insertion order, so the first key is the oldest.
    for (const oldest of tokenCache.keys()) {
      tokenCache.delete(oldest);
      break;
    }
  }
  tokenCache.set(key, {credential, expiresAtSeconds});
}

/** Clears the module-level token cache. Test-only. */
export function resetServiceAccountTokenCache(): void {
  tokenCache.clear();
}

/**
 * Reads the `exp` claim of a JWT, in seconds since the epoch, or `undefined`
 * when the token is not a JWT carrying a finite `exp`. The token is not
 * verified: it comes from Google's token endpoint and is only read to time the
 * cache entry. Never throws, and never surfaces the payload.
 */
function readJwtExpirySeconds(token: string): number | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof claims !== 'object' || claims === null || !('exp' in claims)) {
    return undefined;
  }
  const exp = claims.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
}

/** Returns the explicit key of a configuration, or throws `message`. */
function requireExplicitCredential(
  saConfig: ServiceAccount,
  message: string,
): ServiceAccountCredential {
  if (!saConfig.serviceAccountCredential) {
    throw new AuthCredentialMissingError(message);
  }
  return saConfig.serviceAccountCredential;
}

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
    const creds = saConfig.useDefaultCredential
      ? undefined
      : requireExplicitCredential(
          saConfig,
          ID_TOKEN_CREDENTIAL_MISSING_MESSAGE,
        );

    const key = cacheKey(saConfig);
    const cached = getCachedCredential(key);
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
    setCachedCredential(
      key,
      credential,
      readJwtExpirySeconds(token) ??
        nowSeconds() + DEFAULT_TOKEN_LIFETIME_SECONDS,
    );
    return {credential, wasExchanged: true};
  }

  private async exchangeForAccessToken(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    // The credential check precedes the scopes check so that a configuration
    // missing both reports the more specific failure.
    const creds = saConfig.useDefaultCredential
      ? undefined
      : requireExplicitCredential(
          saConfig,
          ACCESS_TOKEN_CREDENTIAL_MISSING_MESSAGE,
        );
    if (creds && !saConfig.scopes?.length) {
      throw new AuthCredentialMissingError(SCOPES_REQUIRED_MESSAGE);
    }

    const key = cacheKey(saConfig);
    const cached = getCachedCredential(key);
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
    setCachedCredential(
      key,
      credential,
      typeof expiryDateMs === 'number'
        ? expiryDateMs / 1000
        : nowSeconds() + DEFAULT_TOKEN_LIFETIME_SECONDS,
    );
    return {credential, wasExchanged: true};
  }
}
