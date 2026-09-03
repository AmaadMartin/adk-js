/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, OAuth2Client} from 'google-auth-library';
import {OpenAPIV3} from 'openapi-types';

import {Context} from '../agents/context.js';
import {AuthCredential, AuthCredentialTypes} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {isTokenExpired} from '../auth/oauth2/oauth2_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

/** Google's OAuth2 authorization endpoint. */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';

/** Google's OAuth2 token endpoint. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The `type` marker of Google's authorized-user credential file. */
const AUTHORIZED_USER_TYPE = 'authorized_user';

/** The token-endpoint statuses that mean the refresh grant was rejected. */
const REFRESH_REJECTED_STATUSES: readonly number[] = [400, 401];

/** The error marker a token endpoint returns for a dead refresh token. */
const INVALID_GRANT = 'invalid_grant';

/** The options accepted by {@link BaseGoogleCredentialsConfig}. */
export interface GoogleCredentialsConfigOptions {
  /**
   * An existing credential used for every end user, so no end user goes
   * through the OAuth flow. Mutually exclusive with every other field.
   *
   * Use it when the deployment already holds a credential with access to every
   * end user's data — application default credentials on Google Cloud, or a
   * service account key.
   */
  credentials?: AuthClient;
  /**
   * The session-state key an access token is read from. Mutually exclusive
   * with `credentials`, `clientId`, `clientSecret` and `scopes`.
   */
  externalAccessTokenKey?: string;
  /** The OAuth client id to run the authorization-code flow with. */
  clientId?: string;
  /** The OAuth client secret to run the authorization-code flow with. */
  clientSecret?: string;
  /** The OAuth scopes to request. */
  scopes?: string[];
  /**
   * The session-state key the resolved user token is cached under. Set by the
   * toolset that owns the tool. When it is unset, nothing is cached.
   */
  tokenCacheKey?: string;
  /**
   * The key the ADK auth plumbing stores the OAuth credential under. It
   * defaults to a value derived from `clientId` and `scopes`, so two configs
   * asking for different scopes do not share one slot.
   */
  credentialKey?: string;
}

/**
 * How a Google API tool obtains a credential for the current end user
 * (experimental).
 *
 * Supply exactly one of: an existing `credentials` client; an
 * `externalAccessTokenKey` naming a session-state entry that holds an access
 * token; or a `clientId` and `clientSecret` pair to run the OAuth2
 * authorization-code flow with.
 */
@experimental
export class BaseGoogleCredentialsConfig {
  /**
   * The credential used for every end user, when one was supplied.
   *
   * It stays mutable so a toolset can swap in application default credentials
   * after construction. {@link GoogleCredentialsManager} never writes to it.
   */
  credentials?: AuthClient;
  readonly externalAccessTokenKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: string[];
  readonly tokenCacheKey?: string;
  readonly credentialKey: string;

  /**
   * @param options The credential source, and where to cache what it resolves.
   */
  constructor(options: GoogleCredentialsConfigOptions) {
    validateCredentialsOptions(options);

    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.tokenCacheKey = options.tokenCacheKey;

    const suppliedClient =
      options.credentials && isOAuth2Client(options.credentials)
        ? options.credentials
        : undefined;
    this.clientId = suppliedClient?._clientId ?? options.clientId;
    this.clientSecret = suppliedClient?._clientSecret ?? options.clientSecret;
    this.scopes = suppliedClient ? scopesOf(suppliedClient) : options.scopes;

    this.credentialKey =
      options.credentialKey ?? defaultCredentialKey(this.clientId, this.scopes);
  }
}

/**
 * Resolves a Google credential for the current end user, refreshing an expired
 * token and driving the OAuth2 flow when there is nothing to refresh
 * (experimental).
 *
 * Several tools sharing one config also share the token cache in session
 * state, so one authorization serves all of them.
 */
@experimental
export class GoogleCredentialsManager {
  /**
   * @param credentialsConfig Where the credential comes from.
   */
  constructor(readonly credentialsConfig: BaseGoogleCredentialsConfig) {}

  /**
   * Resolves a credential for this call.
   *
   * @param toolContext The context of the call, used for session state and the
   *     OAuth handshake.
   * @return The credential, or `undefined` when an OAuth flow was requested and
   *     the end user has not completed it yet.
   * @throws Error If `externalAccessTokenKey` is configured but session state
   *     holds no token under it, or if refreshing a token fails for a reason
   *     other than the token endpoint rejecting the refresh grant.
   */
  async getValidCredentials(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    const config = this.credentialsConfig;
    if (config.externalAccessTokenKey) {
      return clientFromExternalToken(
        config.externalAccessTokenKey,
        toolContext,
      );
    }

    const client = this.readCachedClient(toolContext) ?? config.credentials;
    if (!client) {
      return this.performOAuthFlow(toolContext);
    }
    if (!isOAuth2Client(client)) {
      return refreshNonOAuthClient(client);
    }
    if (hasValidAccessToken(client)) {
      return client;
    }
    if (isAccessTokenExpired(client) && client.credentials.refresh_token) {
      const refreshed = await this.refresh(client, toolContext);
      if (refreshed) {
        return refreshed;
      }
    }
    return this.performOAuthFlow(toolContext);
  }

  /** Reads the cached token, when one is configured and legible. */
  private readCachedClient(toolContext: Context): OAuth2Client | undefined {
    const key = this.credentialsConfig.tokenCacheKey;
    if (!key) {
      return undefined;
    }
    const cached = toolContext.state.get<string>(key);
    return cached
      ? clientFromAuthorizedUserInfo(cached, this.credentialsConfig)
      : undefined;
  }

  /**
   * Refreshes an expired token. Returns `undefined` when the token endpoint
   * rejected the refresh grant, so the caller starts a new OAuth flow.
   */
  private async refresh(
    client: OAuth2Client,
    toolContext: Context,
  ): Promise<OAuth2Client | undefined> {
    try {
      await client.refreshAccessToken();
    } catch (error: unknown) {
      if (isRefreshError(error)) {
        return undefined;
      }
      throw error;
    }
    if (!hasValidAccessToken(client)) {
      return undefined;
    }
    this.cache(client, toolContext);
    return client;
  }

  /** Completes a finished OAuth flow, or requests one. */
  private performOAuthFlow(toolContext: Context): OAuth2Client | undefined {
    const config = this.credentialsConfig;
    const authConfig = buildAuthConfig(config);
    const oauth2 = toolContext.getAuthResponse(authConfig)?.oauth2;
    if (!oauth2) {
      toolContext.requestCredential(authConfig);
      return undefined;
    }

    const client = new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    client.setCredentials({
      access_token: oauth2.accessToken,
      refresh_token: oauth2.refreshToken,
      expiry_date: oauth2.expiresAt,
      scope: config.scopes?.join(' '),
    });
    this.cache(client, toolContext);
    return client;
  }

  /** Writes the token to session state, when a cache key is configured. */
  private cache(client: OAuth2Client, toolContext: Context): void {
    const key = this.credentialsConfig.tokenCacheKey;
    if (key) {
      toolContext.state.set(
        key,
        serializeAuthorizedUser(client, this.credentialsConfig),
      );
    }
  }
}

/**
 * Rejects a config that names more than one credential source, or none.
 *
 * The messages name the TypeScript fields rather than adk-python's snake_case
 * ones: they are developer diagnostics, not values that cross the boundary.
 */
function validateCredentialsOptions(
  options: GoogleCredentialsConfigOptions,
): void {
  const oauthFieldsSet = Boolean(
    options.clientId || options.clientSecret || options.scopes,
  );
  if (options.credentials) {
    if (options.externalAccessTokenKey || oauthFieldsSet) {
      throw new Error(
        'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.',
      );
    }
    return;
  }
  if (options.externalAccessTokenKey) {
    if (oauthFieldsSet) {
      throw new Error(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.',
      );
    }
    return;
  }
  if (!options.clientId || !options.clientSecret) {
    throw new Error(
      'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
    );
  }
}

/** A slot name that is stable per client and scope set. */
function defaultCredentialKey(
  clientId: string | undefined,
  scopes: string[] | undefined,
): string {
  const sortedScopes = [...(scopes ?? [])].sort().join(',');
  return `google_tool_${clientId ?? 'default'}_${sortedScopes}`;
}

/**
 * Whether `client` holds an end user's OAuth2 credential.
 *
 * This is the parity mapping of adk-python's `isinstance(creds,
 * google.oauth2.credentials.Credentials)`. It is structural rather than an
 * `instanceof` test, because an object built by a second copy of
 * google-auth-library in the same runtime fails an identity test. Service
 * account and compute clients extend the same class, so the OAuth client id
 * and secret are what separate an end-user credential from them.
 */
function isOAuth2Client(client: AuthClient): client is OAuth2Client {
  return (
    'refreshAccessToken' in client &&
    typeof client.refreshAccessToken === 'function' &&
    '_clientId' in client &&
    typeof client._clientId === 'string' &&
    '_clientSecret' in client &&
    typeof client._clientSecret === 'string'
  );
}

/** The scopes an OAuth2 client was granted. */
function scopesOf(client: OAuth2Client): string[] | undefined {
  return client.credentials.scope?.split(' ');
}

/** Whether the client's access token is set and has not expired. */
function hasValidAccessToken(client: AuthClient): boolean {
  return (
    Boolean(client.credentials.access_token) && !isAccessTokenExpired(client)
  );
}

/** Whether the client's access token carries an expiry that has passed. */
function isAccessTokenExpired(client: AuthClient): boolean {
  return isTokenExpired({
    expiresAt: client.credentials.expiry_date ?? undefined,
  });
}

/** Builds a client from an access token another system already obtained. */
function clientFromExternalToken(
  key: string,
  toolContext: Context,
): OAuth2Client {
  const accessToken = toolContext.state.get<string>(key);
  if (!accessToken) {
    throw new Error(
      `externalAccessTokenKey is provided but no access token found in toolContext.state with key ${key}.`,
    );
  }
  const client = new OAuth2Client();
  client.setCredentials({access_token: accessToken});
  return client;
}

/**
 * Refreshes a service account or compute credential, and returns it either
 * way: some client libraries refresh internally, so a failure here is not
 * fatal. This path never starts an OAuth flow.
 */
async function refreshNonOAuthClient(client: AuthClient): Promise<AuthClient> {
  if (hasValidAccessToken(client)) {
    return client;
  }
  try {
    await client.getAccessToken();
  } catch {
    // Deliberately ignored; the caller gets the client as it is.
  }
  return client;
}

/** The OAuth2 authorization-code handshake this config asks the user for. */
function buildAuthConfig(config: BaseGoogleCredentialsConfig): AuthConfig {
  const authScheme: OpenAPIV3.OAuth2SecurityScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        scopes: Object.fromEntries(
          (config.scopes ?? []).map((scope) => [scope, `Access to ${scope}`]),
        ),
      },
    },
  };
  const rawAuthCredential: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: config.clientId, clientSecret: config.clientSecret},
  };
  return {authScheme, rawAuthCredential, credentialKey: config.credentialKey};
}

/**
 * Serializes a token for the session-state cache.
 *
 * The payload is shaped like Google's authorized-user credential file, so a
 * token adk-js cached stays legible to the tooling adk-python targets. Those
 * key names cross the language boundary, so they stay snake_case.
 */
function serializeAuthorizedUser(
  client: OAuth2Client,
  config: BaseGoogleCredentialsConfig,
): string {
  return JSON.stringify({
    type: AUTHORIZED_USER_TYPE,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: client.credentials.refresh_token,
    access_token: client.credentials.access_token,
    expiry_date: client.credentials.expiry_date,
    scopes: config.scopes,
  });
}

/** Rebuilds a client from a {@link serializeAuthorizedUser} payload. */
function clientFromAuthorizedUserInfo(
  json: string,
  config: BaseGoogleCredentialsConfig,
): OAuth2Client | undefined {
  const parsed = parseJson(json);
  if (!isRecord(parsed)) {
    logger.debug('Ignoring an unreadable Google token cache entry.');
    return undefined;
  }
  const client = new OAuth2Client({
    clientId: stringField(parsed, 'client_id') ?? config.clientId,
    clientSecret: stringField(parsed, 'client_secret') ?? config.clientSecret,
  });
  client.setCredentials({
    access_token: stringField(parsed, 'access_token'),
    refresh_token: stringField(parsed, 'refresh_token'),
    expiry_date: numberField(parsed, 'expiry_date'),
    scope: config.scopes?.join(' '),
  });
  return client;
}

/**
 * Whether a thrown value is the token endpoint rejecting a refresh grant, as
 * opposed to a programming or transport fault.
 *
 * google-auth-library exports no counterpart of adk-python's
 * `google.auth.exceptions.RefreshError`, so the rejection is recognised by its
 * HTTP status and its `invalid_grant` marker.
 */
function isRefreshError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return hasRejectedStatus(error) || mentionsInvalidGrant(error);
}

function hasRejectedStatus(error: Record<string, unknown>): boolean {
  const response = error['response'];
  const status =
    numberField(error, 'status') ??
    (isRecord(response) ? numberField(response, 'status') : undefined);
  return status !== undefined && REFRESH_REJECTED_STATUSES.includes(status);
}

function mentionsInvalidGrant(error: Record<string, unknown>): boolean {
  const marker = `${stringField(error, 'error') ?? ''} ${
    stringField(error, 'error_description') ?? ''
  }`;
  return marker.includes(INVALID_GRANT);
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}
