/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';

import {AuthClient, OAuth2Client, UserRefreshClient} from 'google-auth-library';

import {Context} from '../agents/context.js';
import {AuthCredential, AuthCredentialTypes} from '../auth/auth_credential.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

/** Where the end user grants consent. */
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';

/** Where an authorization code or a refresh token is exchanged for a token. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The `type` google-auth-library requires in an authorized-user JSON blob. */
const AUTHORIZED_USER_TYPE = 'authorized_user';

/** Prefix of every session-state key minted by {@link googleCredentialKey}. */
const CREDENTIAL_KEY_PREFIX = 'google_credentials_';

/** Hex characters of the digest kept in a {@link googleCredentialKey}. */
const CREDENTIAL_KEY_DIGEST_LENGTH = 16;

/**
 * The cached credential, in the shape `Credentials.to_json()` writes in
 * adk-python. A session written by either SDK is readable by the other.
 */
interface AuthorizedUserCache {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  /** The access token. Named `token` by adk-python, not `access_token`. */
  token?: string;
  token_uri?: string;
  scopes?: string[];
  /** ISO 8601 instant the access token expires at. */
  expiry?: string;
}

/** Options accepted by {@link BaseGoogleCredentialsConfig}. */
export interface BaseGoogleCredentialsConfigOptions {
  /**
   * Credentials the tool already holds, used for every end user. Mutually
   * exclusive with every other option here.
   */
  credentials?: AuthClient;
  /**
   * Session-state key holding an access token the host obtained elsewhere.
   * Mutually exclusive with {@link credentials} and with the OAuth2 client.
   */
  externalAccessTokenKey?: string;
  /** The OAuth2 client id used to run a consent flow. */
  clientId?: string;
  /** The OAuth2 client secret used to run a consent flow. */
  clientSecret?: string;
  /** The OAuth2 scopes to ask the end user for. */
  scopes?: string[];
}

/**
 * How a Google API tool obtains credentials (Experimental).
 *
 * Exactly one of three modes is active: credentials the tool already holds, an
 * access token the host puts in session state, or an OAuth2 client that drives
 * the end user through a consent flow. The constructor rejects any other
 * combination.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BaseGoogleCredentialsConfig {
  readonly credentials?: AuthClient;
  readonly externalAccessTokenKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: string[];
  /** Session-state key the credential is cached under. Set by a subclass. */
  readonly tokenCacheKey?: string;

  constructor(options: BaseGoogleCredentialsConfigOptions) {
    validateCredentialsConfig(options);

    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;

    // User credentials already carry the OAuth2 client that minted them, so a
    // consent flow can be re-run without the caller repeating it.
    const userCredentials =
      options.credentials && isUserOAuth2Credentials(options.credentials)
        ? options.credentials
        : undefined;
    this.clientId = userCredentials?._clientId ?? options.clientId;
    this.clientSecret = userCredentials?._clientSecret ?? options.clientSecret;
    this.scopes = userCredentials ? scopesOf(userCredentials) : options.scopes;
  }
}

/** Manages Google API credentials, refreshing them and running OAuth2 consent. */
export class GoogleCredentialsManager {
  constructor(readonly credentialsConfig: BaseGoogleCredentialsConfig) {}

  /**
   * Resolves live credentials for this tool call.
   *
   * @param toolContext The tool context supplying session state and the OAuth2
   *     request/response channel.
   * @return The credentials, or `undefined` when a consent flow was requested
   *     and the tool should return so the end user can respond.
   */
  async getValidCredentials(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    const config = this.credentialsConfig;

    if (config.externalAccessTokenKey) {
      return externalAccessTokenCredentials(
        config.externalAccessTokenKey,
        toolContext,
      );
    }

    const credentials =
      readCachedCredentials(config, toolContext) ?? config.credentials;

    if (credentials) {
      // Service account, application default and metadata credentials cannot
      // be re-obtained by asking the end user, so they never start a flow.
      if (!isUserOAuth2Credentials(credentials)) {
        return refreshNonUserCredentials(credentials);
      }
      if (isCredentialValid(credentials)) {
        return credentials;
      }
      const refreshed = await refreshUserCredentials(credentials);
      if (refreshed) {
        writeCachedCredentials(config, toolContext, credentials);
        return credentials;
      }
    }

    return performOAuthFlow(config, toolContext);
  }
}

/** Epoch-ms expiry has passed. Mirrors adk-python's `Credentials.expired`. */
export function isCredentialExpired(client: AuthClient): boolean {
  const expiryDate = client.credentials.expiry_date;
  return expiryDate != null && expiryDate <= Date.now();
}

/** Has an access token and is not expired. Mirrors `Credentials.valid`. */
export function isCredentialValid(client: AuthClient): boolean {
  return !!client.credentials.access_token && !isCredentialExpired(client);
}

/**
 * Whether these credentials came from a user OAuth2 consent flow, and so can
 * be re-obtained by running that flow again.
 *
 * Neither the base class nor a refresh token discriminates. `JWT`, `Compute`
 * and `Impersonated` all extend `OAuth2Client`, and each writes its own
 * placeholder into `credentials.refresh_token`. `UserRefreshClient` is the
 * only client that refreshes with a real user refresh token, and the
 * `_refreshToken` field it declares is the marker for it.
 *
 * A bare `OAuth2Client` is therefore classified non-user here, where
 * adk-python classifies an equivalent `google.oauth2.credentials.Credentials`
 * as a user credential. Both paths refresh it when it is stale and return it,
 * so the credentials the caller receives are the same.
 */
export function isUserOAuth2Credentials(
  client: AuthClient,
): client is OAuth2Client {
  return '_refreshToken' in client && 'refreshAccessToken' in client;
}

/**
 * Whether a refresh failed at the token endpoint, as opposed to a bug in the
 * caller. Mirrors adk-python's `except RefreshError`: only a rejection by the
 * endpoint may fall through to a new consent flow.
 */
export function isTokenRefreshFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'GaxiosError') {
    return true;
  }
  return 'status' in error && typeof error.status === 'number';
}

/**
 * The {@link AuthConfig.credentialKey} for an OAuth2 client and scope set.
 *
 * Two different clients, or two different scope sets, must not share a key, or
 * one tool's consent would satisfy another's. The digest keeps the state key
 * bounded; nothing secret goes into it.
 */
export function googleCredentialKey(
  clientId: string | undefined,
  scopes: readonly string[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({clientId, scopes: [...scopes].sort()}))
    .digest('hex')
    .slice(0, CREDENTIAL_KEY_DIGEST_LENGTH);
  return `${CREDENTIAL_KEY_PREFIX}${digest}`;
}

/** Rejects any option combination that is not exactly one credential mode. */
function validateCredentialsConfig(
  options: BaseGoogleCredentialsConfigOptions,
): void {
  if (options.credentials) {
    if (
      options.externalAccessTokenKey ||
      options.clientId ||
      options.clientSecret ||
      options.scopes
    ) {
      throw new InputValidationError(
        'If credentials are provided, externalAccessTokenKey, clientId, ' +
          'clientSecret, and scopes must not be provided.',
      );
    }
    return;
  }

  if (options.externalAccessTokenKey) {
    if (options.clientId || options.clientSecret || options.scopes) {
      throw new InputValidationError(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
          'scopes must not be provided.',
      );
    }
    return;
  }

  if (!options.clientId || !options.clientSecret) {
    throw new InputValidationError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  }
}

/** The granted scopes, which google-auth-library stores space-delimited. */
function scopesOf(client: AuthClient): string[] | undefined {
  return client.credentials.scope?.split(' ');
}

/** Builds credentials from an access token the host put in session state. */
function externalAccessTokenCredentials(
  key: string,
  toolContext: Context,
): OAuth2Client {
  const accessToken = toolContext.state.get<string>(key);
  if (!accessToken) {
    throw new InputValidationError(
      'externalAccessTokenKey is provided but no access token found in ' +
        `toolContext.state with key ${key}.`,
    );
  }

  const client = new OAuth2Client();
  client.setCredentials({access_token: accessToken});
  return client;
}

/**
 * Refreshes credentials that no consent flow can replace, and returns them
 * whether or not that worked: a library that refreshes internally may still
 * be able to use them.
 */
async function refreshNonUserCredentials(
  client: AuthClient,
): Promise<AuthClient> {
  if (!isCredentialValid(client)) {
    try {
      await client.getAccessToken();
    } catch (e: unknown) {
      logger.debug(`Google credentials refresh failed: ${formatError(e)}`);
    }
  }
  return client;
}

/**
 * Refreshes expired user credentials in place.
 *
 * @return Whether the credentials are now valid. A rejection by the token
 *     endpoint reports `false`, so the caller can start a new consent flow.
 *     Any other error propagates, because it is a bug rather than an expired
 *     grant.
 */
async function refreshUserCredentials(client: OAuth2Client): Promise<boolean> {
  if (!isCredentialExpired(client) || !client.credentials.refresh_token) {
    return false;
  }

  try {
    await client.refreshAccessToken();
  } catch (e: unknown) {
    if (!isTokenRefreshFailure(e)) {
      throw e;
    }
    return false;
  }

  return isCredentialValid(client);
}

/** Reads the cached credential, when the config names a cache key. */
function readCachedCredentials(
  config: BaseGoogleCredentialsConfig,
  toolContext: Context,
): UserRefreshClient | undefined {
  if (!config.tokenCacheKey) {
    return undefined;
  }
  const cached = toolContext.state.get<string>(config.tokenCacheKey);
  if (!cached) {
    return undefined;
  }

  const parsed: AuthorizedUserCache = JSON.parse(cached);
  const client = UserRefreshClient.fromJSON({
    // An entry written by adk-python carries no `type`, which `fromJSON`
    // requires. Every entry under this key is an authorized user by
    // construction.
    type: AUTHORIZED_USER_TYPE,
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
    refresh_token: parsed.refresh_token,
  });
  client.setCredentials({
    access_token: parsed.token,
    refresh_token: parsed.refresh_token,
    expiry_date: parsed.expiry ? Date.parse(parsed.expiry) : undefined,
    scope: config.scopes?.join(' '),
  });
  return client;
}

/** Writes the credential to the cache, when the config names a cache key. */
function writeCachedCredentials(
  config: BaseGoogleCredentialsConfig,
  toolContext: Context,
  client: OAuth2Client,
): void {
  if (!config.tokenCacheKey) {
    return;
  }

  const {access_token, refresh_token, expiry_date} = client.credentials;
  const cache: AuthorizedUserCache = {
    type: AUTHORIZED_USER_TYPE,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refresh_token ?? undefined,
    token: access_token ?? undefined,
    token_uri: TOKEN_URL,
    scopes: config.scopes,
    expiry:
      expiry_date != null ? new Date(expiry_date).toISOString() : undefined,
  };
  toolContext.state.set(config.tokenCacheKey, JSON.stringify(cache));
}

/** The Google OAuth2 authorization-code request for this configuration. */
function buildAuthConfig(config: BaseGoogleCredentialsConfig): AuthConfig {
  // adk-python iterates `scopes` unguarded here and raises when it is unset,
  // which its own validator allows. An empty scope set is the sane reading.
  const scopes = config.scopes ?? [];
  const authScheme: AuthScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: AUTHORIZATION_URL,
        tokenUrl: TOKEN_URL,
        scopes: Object.fromEntries(
          scopes.map((scope) => [scope, `Access to ${scope}`]),
        ),
      },
    },
  };
  const rawAuthCredential: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: config.clientId, clientSecret: config.clientSecret},
  };

  return {
    authScheme,
    rawAuthCredential,
    credentialKey: googleCredentialKey(config.clientId, scopes),
  };
}

/**
 * Collects the end user's OAuth2 consent.
 *
 * @return The new credentials, or `undefined` when consent was requested and
 *     the end user has not responded yet.
 */
async function performOAuthFlow(
  config: BaseGoogleCredentialsConfig,
  toolContext: Context,
): Promise<OAuth2Client | undefined> {
  const authConfig = buildAuthConfig(config);
  const authResponse = toolContext.getAuthResponse(authConfig);

  if (!authResponse?.oauth2) {
    toolContext.requestCredential(authConfig);
    return undefined;
  }

  const client = new UserRefreshClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: authResponse.oauth2.refreshToken,
  });
  client.setCredentials({
    access_token: authResponse.oauth2.accessToken,
    refresh_token: authResponse.oauth2.refreshToken,
    scope: config.scopes?.join(' '),
  });
  writeCachedCredentials(config, toolContext, client);
  return client;
}
