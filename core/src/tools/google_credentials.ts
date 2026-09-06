/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, OAuth2Client} from 'google-auth-library';

import {Context} from '../agents/context.js';
import {AuthCredentialTypes} from '../auth/auth_credential.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

const GOOGLE_OAUTH_AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const CREDENTIALS_CONFLICT_ERROR =
  'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.';
const EXTERNAL_TOKEN_CONFLICT_ERROR =
  'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.';
const NO_CREDENTIAL_MODE_ERROR =
  'Must provide one of credentials, externalAccessTokenKey, or a clientId and clientSecret pair.';

/** Options accepted by {@link BaseGoogleCredentialsConfig}. */
export interface BaseGoogleCredentialsConfigOptions {
  /**
   * A pre-resolved credential used for every end user, so end users never go
   * through an OAuth flow. Mutually exclusive with `externalAccessTokenKey` and
   * with the `clientId` / `clientSecret` / `scopes` trio.
   *
   * Only set this when the credential is allowed to access every end user's
   * data — for example application default credentials in a Google Cloud
   * deployment, or a service account key.
   */
  credentials?: AuthClient;
  /**
   * The tool-context state key holding an access token supplied by the host
   * application. Mutually exclusive with `credentials`.
   */
  externalAccessTokenKey?: string;
  /** The OAuth client id used to drive an interactive authorization flow. */
  clientId?: string;
  /** The OAuth client secret used to drive an interactive authorization flow. */
  clientSecret?: string;
  /** The OAuth scopes requested from the end user. */
  scopes?: string[];
  /**
   * The session state key under which the authorized token is cached.
   *
   * Defaults to a key derived from `clientId` and `scopes` for the interactive
   * OAuth mode, and is unset for the other two modes: a pre-supplied
   * credential is shared by every end user, and an external access token is
   * owned by the host application. Toolset subclasses may override it.
   *
   * Warning: the cached entry includes the refresh token. Session state may be
   * persisted in plaintext, logged, or exposed by the runner environment, so
   * treat a cached Google token the same way `SessionStateCredentialService`
   * asks you to treat any credential in session state.
   */
  tokenCacheKey?: string;
}

/**
 * The token shape cached under {@link BaseGoogleCredentialsConfig.tokenCacheKey}.
 *
 * Each field mirrors the `google-auth-library` `Credentials` field of the same
 * name, nullability included, so the cache round-trips without translation.
 */
interface CachedGoogleToken {
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Epoch milliseconds, mirroring `google-auth-library`'s `expiry_date`. */
  expiryDate?: number | null;
  /** Space-delimited scopes, mirroring `google-auth-library`'s `scope`. */
  scope?: string;
}

/**
 * Rejects an options object that does not describe exactly one credential
 * mode.
 */
function validateCredentialMode(
  options: BaseGoogleCredentialsConfigOptions,
): void {
  if (options.credentials) {
    if (
      options.externalAccessTokenKey ||
      options.clientId ||
      options.clientSecret ||
      options.scopes
    ) {
      throw new Error(CREDENTIALS_CONFLICT_ERROR);
    }
    return;
  }

  if (options.externalAccessTokenKey) {
    if (options.clientId || options.clientSecret || options.scopes) {
      throw new Error(EXTERNAL_TOKEN_CONFLICT_ERROR);
    }
    return;
  }

  if (!options.clientId || !options.clientSecret) {
    throw new Error(NO_CREDENTIAL_MODE_ERROR);
  }
}

/**
 * Detects an OAuth2 client structurally.
 *
 * `instanceof` is unreliable when two copies of a package share a runtime, so
 * the check probes for a member only {@link OAuth2Client} declares.
 */
function isOAuth2Client(client: AuthClient): client is OAuth2Client {
  return (
    'generateAuthUrl' in client && typeof client.generateAuthUrl === 'function'
  );
}

/**
 * Reports whether a client already holds a usable access token.
 *
 * `google-auth-library` exposes no `valid` flag: a client is usable when it
 * holds an access token that has not entered its own eager-refresh window.
 */
function hasValidAccessToken(client: AuthClient): boolean {
  const {access_token: accessToken, expiry_date: expiryDate} =
    client.credentials;
  if (!accessToken) {
    return false;
  }
  if (expiryDate == null) {
    return true;
  }
  return expiryDate - client.eagerRefreshThresholdMillis > Date.now();
}

/** Builds an OAuth2 client carrying the config's client id and secret. */
function newOAuth2Client(config: BaseGoogleCredentialsConfig): OAuth2Client {
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
}

/** Rebuilds a client from the token cached in the tool context state. */
function readCachedClient(
  config: BaseGoogleCredentialsConfig,
  toolContext: Context,
): OAuth2Client | undefined {
  if (!config.tokenCacheKey) {
    return undefined;
  }

  const cached = toolContext.state.get<CachedGoogleToken>(config.tokenCacheKey);
  if (!cached) {
    return undefined;
  }

  const client = newOAuth2Client(config);
  client.setCredentials({
    access_token: cached.accessToken,
    refresh_token: cached.refreshToken,
    expiry_date: cached.expiryDate,
    scope: cached.scope,
  });
  return client;
}

/**
 * Caches a client's token in the tool context state, if the config declares a
 * cache key.
 */
function cacheToken(
  config: BaseGoogleCredentialsConfig,
  toolContext: Context,
  client: AuthClient,
): void {
  if (!config.tokenCacheKey) {
    return;
  }

  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
    scope,
  } = client.credentials;
  const token: CachedGoogleToken = {
    accessToken,
    refreshToken,
    expiryDate,
    scope,
  };
  toolContext.state.set(config.tokenCacheKey, token);
}

/**
 * Derives the credential key that `AuthHandler` uses to store and read the
 * authorization response.
 *
 * adk-python derives this key internally from the auth config; adk-js requires
 * it explicitly, so it must be computed deterministically for the
 * `requestCredential` write and the later `getAuthResponse` read to agree.
 */
function googleCredentialKey(config: BaseGoogleCredentialsConfig): string {
  const scopes = [...(config.scopes ?? [])].sort().join(',');
  return `google_${config.clientId}_${scopes}`;
}

/**
 * Chooses the cache key a config uses when it does not name one.
 *
 * A completed authorization is handed back through `temp:` session state,
 * which `BaseSessionService` drops before persisting the session, so without a
 * cache the end user would re-authorize on every invocation. Only the
 * interactive mode caches: a pre-supplied credential is shared by every end
 * user, and an external access token is owned by the host application.
 */
function defaultTokenCacheKey(
  config: BaseGoogleCredentialsConfig,
): string | undefined {
  if (config.credentials || config.externalAccessTokenKey) {
    return undefined;
  }
  return googleCredentialKey(config);
}

/** Builds the authorization-code auth config for the interactive flow. */
function buildAuthConfig(config: BaseGoogleCredentialsConfig): AuthConfig {
  const authScheme: AuthScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
        tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
        scopes: Object.fromEntries(
          (config.scopes ?? []).map((scope) => [scope, `Access to ${scope}`]),
        ),
      },
    },
  };

  return {
    authScheme,
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      },
    },
    credentialKey: googleCredentialKey(config),
  };
}

/**
 * Base Google credentials configuration for Google API tools.
 *
 * Exactly one credential mode must be configured: a pre-resolved
 * {@link BaseGoogleCredentialsConfigOptions.credentials}, an
 * {@link BaseGoogleCredentialsConfigOptions.externalAccessTokenKey}, or a
 * `clientId` / `clientSecret` pair driving an interactive OAuth flow.
 */
@experimental
export class BaseGoogleCredentialsConfig {
  credentials?: AuthClient;
  externalAccessTokenKey?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  tokenCacheKey?: string;

  /**
   * @param options The credential mode to configure.
   * @throws If the options do not describe exactly one credential mode.
   */
  constructor(options: BaseGoogleCredentialsConfigOptions = {}) {
    validateCredentialMode(options);

    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes;

    // A supplied OAuth2 credential already carries the client identity a later
    // interactive flow would need, so adopt it.
    if (this.credentials && isOAuth2Client(this.credentials)) {
      this.clientId = this.credentials._clientId;
      this.clientSecret = this.credentials._clientSecret;
      this.scopes = this.credentials.credentials.scope?.split(' ');
    }

    this.tokenCacheKey = options.tokenCacheKey ?? defaultTokenCacheKey(this);
  }
}

/**
 * Manages Google API credentials with automatic refresh and OAuth flow
 * handling.
 *
 * Centralizing credential management lets multiple tools share the same
 * authenticated session without duplicating OAuth logic.
 */
@experimental
export class GoogleCredentialsManager {
  /**
   * @param credentialsConfig The credential configuration to resolve against.
   */
  constructor(readonly credentialsConfig: BaseGoogleCredentialsConfig) {}

  /**
   * Resolves a usable credential, refreshing it or starting an OAuth flow as
   * needed.
   *
   * @param toolContext The context of the current tool call, used for OAuth
   *     flow orchestration and state access.
   * @returns The resolved credential, or `undefined` when an OAuth flow has
   *     been requested and is still in flight.
   * @throws If `externalAccessTokenKey` is configured but state holds no token.
   */
  async getValidCredentials(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    const config = this.credentialsConfig;

    if (config.externalAccessTokenKey) {
      const accessToken = toolContext.state.get<string>(
        config.externalAccessTokenKey,
      );
      if (!accessToken) {
        throw new Error(
          `externalAccessTokenKey is provided but no access token found in tool context state with key ${config.externalAccessTokenKey}.`,
        );
      }
      const client = new OAuth2Client();
      client.setCredentials({access_token: accessToken});
      return client;
    }

    const client = readCachedClient(config, toolContext) ?? config.credentials;

    // A non-OAuth2 credential (service account, ADC, Compute, JWT) never drives
    // an interactive flow; it mints its own token.
    if (client && !isOAuth2Client(client)) {
      if (!hasValidAccessToken(client)) {
        try {
          await client.getAccessToken();
        } catch (error) {
          // The credential may still work for libraries that refresh
          // internally, so hand it back unchanged.
          logger.warn(
            'Could not mint a token for the supplied Google credential:',
            error,
          );
        }
      }
      return client;
    }

    if (client && hasValidAccessToken(client)) {
      return client;
    }

    if (client?.credentials.refresh_token) {
      try {
        await client.getAccessToken();
        if (hasValidAccessToken(client)) {
          cacheToken(config, toolContext, client);
          return client;
        }
      } catch (error) {
        // The refresh token is no longer usable; re-authorize below.
        logger.warn(
          'Could not refresh the Google credential, re-authorizing:',
          error,
        );
      }
    }

    return this.performOAuthFlow(toolContext);
  }

  /**
   * Requests an interactive authorization, or consumes the response of one
   * already completed.
   *
   * @param toolContext The context of the current tool call.
   * @returns The authorized client, or `undefined` when the flow is in flight.
   */
  private performOAuthFlow(toolContext: Context): OAuth2Client | undefined {
    const config = this.credentialsConfig;
    const authConfig = buildAuthConfig(config);
    const authResponse = toolContext.getAuthResponse(authConfig);

    if (!authResponse?.oauth2) {
      toolContext.requestCredential(authConfig);
      return undefined;
    }

    const client = newOAuth2Client(config);
    client.setCredentials({
      access_token: authResponse.oauth2.accessToken,
      refresh_token: authResponse.oauth2.refreshToken,
      expiry_date: authResponse.oauth2.expiresAt,
      scope: config.scopes?.join(' '),
    });
    cacheToken(config, toolContext, client);
    return client;
  }
}
