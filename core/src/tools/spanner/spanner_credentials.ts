/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, Credentials, OAuth2Client} from 'google-auth-library';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {AuthConfig} from '../../auth/auth_tool.js';

/** The session state key the Spanner tools cache their OAuth token under. */
export const SPANNER_TOKEN_CACHE_KEY = 'spanner_token_cache';

/** The OAuth scopes the Spanner tools request when none are configured. */
export const SPANNER_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/spanner.admin',
  'https://www.googleapis.com/auth/spanner.data',
];

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Constructor options for {@link SpannerCredentialsConfig}. */
export interface SpannerCredentialsConfigOptions {
  /**
   * An auth client to use for every end user, so no user goes through the
   * OAuth flow. Mutually exclusive with every other option.
   */
  credentials?: AuthClient;
  /**
   * The session state key holding an access token supplied by the
   * application. Mutually exclusive with `credentials`, `clientId`,
   * `clientSecret` and `scopes`.
   */
  externalAccessTokenKey?: string;
  /** The OAuth client id. */
  clientId?: string;
  /** The OAuth client secret. */
  clientSecret?: string;
  /** The OAuth scopes. Defaults to {@link SPANNER_DEFAULT_SCOPES}. */
  scopes?: string[];
}

/**
 * How the Spanner tools authenticate to Cloud Spanner.
 *
 * Exactly one of three sources must be configured: an auth client, a session
 * state key holding an access token, or an OAuth client id and secret pair
 * that drives the interactive flow.
 */
export class SpannerCredentialsConfig {
  readonly credentials?: AuthClient;
  readonly externalAccessTokenKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes: string[];
  /** The session state key the resolved token is cached under. */
  readonly tokenCacheKey = SPANNER_TOKEN_CACHE_KEY;

  constructor(options: SpannerCredentialsConfigOptions) {
    const {credentials, externalAccessTokenKey, clientId, clientSecret} =
      options;
    const scopes = options.scopes;

    if (credentials) {
      if (externalAccessTokenKey || clientId || clientSecret || scopes) {
        throw new Error(
          'If credentials are provided, external_access_token_key, client_id,' +
            ' client_secret, and scopes must not be provided.',
        );
      }
    } else if (externalAccessTokenKey) {
      if (clientId || clientSecret || scopes) {
        throw new Error(
          'If external_access_token_key is provided, client_id,' +
            ' client_secret, and scopes must not be provided.',
        );
      }
    } else if (!clientId || !clientSecret) {
      throw new Error(
        'Must provide one of credentials, external_access_token_key, or' +
          ' client_id and client_secret pair.',
      );
    }

    this.credentials = credentials;
    this.externalAccessTokenKey = externalAccessTokenKey;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scopes = scopes?.length ? scopes : SPANNER_DEFAULT_SCOPES;
  }
}

/**
 * The token shape cached in the session state.
 *
 * It is the subset of `google-auth-library`'s `Credentials` that survives a
 * round trip through a session service, which stores plain JSON.
 */
export interface CachedSpannerToken {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
}

/**
 * Resolves the credentials the Spanner tools call Cloud Spanner with,
 * refreshing an expired token and driving the OAuth flow when there is none.
 */
export class SpannerCredentialsManager {
  constructor(readonly config: SpannerCredentialsConfig) {}

  /**
   * Returns the credentials to call Cloud Spanner with, or `undefined` when
   * the OAuth flow has been requested and the user has not completed it yet.
   *
   * @param toolContext The context of the call, used to read the token cache
   *   and to drive the OAuth flow.
   */
  async getValidCredentials(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    if (this.config.credentials) {
      return this.config.credentials;
    }
    if (this.config.externalAccessTokenKey) {
      return readExternalToken(toolContext, this.config.externalAccessTokenKey);
    }
    const cached = await this.readCachedToken(toolContext);
    return cached ?? this.completeOAuthFlow(toolContext);
  }

  /**
   * Returns the cached token, refreshing it first when it has expired.
   * Returns `undefined` when there is no usable cached token, so the caller
   * falls through to the OAuth flow.
   */
  private async readCachedToken(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    const cached = toolContext.state.get<CachedSpannerToken>(
      this.config.tokenCacheKey,
    );
    if (!cached) {
      return undefined;
    }
    if (!isExpired(cached)) {
      return clientForToken(cached);
    }
    if (!cached.refreshToken) {
      return undefined;
    }
    return this.refresh(toolContext, cached.refreshToken);
  }

  /**
   * Exchanges a refresh token for a fresh access token and re-caches it.
   * Returns `undefined` when the exchange fails, so the caller falls through
   * to the OAuth flow.
   */
  private async refresh(
    toolContext: Context,
    refreshToken: string,
  ): Promise<AuthClient | undefined> {
    const client = new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    client.setCredentials({refresh_token: refreshToken});
    try {
      const {credentials} = await client.refreshAccessToken();
      client.setCredentials({refresh_token: refreshToken, ...credentials});
      this.cacheToken(toolContext, credentials, refreshToken);
      return client;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the credentials the user granted, or asks for them.
   *
   * @return The credentials, or `undefined` when the authorization request
   *   has just been raised and the user has not answered it yet.
   */
  private completeOAuthFlow(toolContext: Context): AuthClient | undefined {
    const authConfig = this.buildAuthConfig();
    const granted = toolContext.getAuthResponse(authConfig)?.oauth2;
    if (!granted?.accessToken) {
      toolContext.requestCredential(authConfig);
      return undefined;
    }
    const credentials: Credentials = {
      access_token: granted.accessToken,
      refresh_token: granted.refreshToken,
      expiry_date: granted.expiresAt,
    };
    this.cacheToken(toolContext, credentials);
    const client = new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    client.setCredentials(credentials);
    return client;
  }

  /** Builds the OAuth2 authorization-code config for the configured scopes. */
  private buildAuthConfig(): AuthConfig {
    const scopes = Object.fromEntries(
      this.config.scopes.map((scope) => [scope, `Access to ${scope}`]),
    );
    const authScheme: OpenAPIV3.OAuth2SecurityScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: AUTHORIZATION_URL,
          tokenUrl: TOKEN_URL,
          scopes,
        },
      },
    };
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      },
    };
    return {
      authScheme,
      rawAuthCredential,
      credentialKey: this.config.tokenCacheKey,
    };
  }

  /** Writes the token to the session state so the next call reuses it. */
  private cacheToken(
    toolContext: Context,
    credentials: Credentials,
    fallbackRefreshToken?: string,
  ): void {
    if (!credentials.access_token) {
      return;
    }
    const cached: CachedSpannerToken = {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? fallbackRefreshToken,
      expiryDate: credentials.expiry_date ?? undefined,
    };
    toolContext.state.set(this.config.tokenCacheKey, cached);
  }
}

/** Reads the access token the application put in the session state. */
function readExternalToken(toolContext: Context, key: string): AuthClient {
  const accessToken = toolContext.state.get<string>(key);
  if (!accessToken) {
    throw new Error(
      'external_access_token_key is provided but no access token found in' +
        ` tool_context.state with key ${key}.`,
    );
  }
  return clientForToken({accessToken});
}

/** Whether a cached token has passed its expiry. */
function isExpired(token: CachedSpannerToken): boolean {
  return token.expiryDate !== undefined && token.expiryDate <= Date.now();
}

/** Wraps a bare access token in a client the Spanner SDK accepts. */
function clientForToken(token: CachedSpannerToken): AuthClient {
  const client = new OAuth2Client();
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiryDate,
  });
  return client;
}
