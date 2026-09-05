/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuth2Client} from 'google-auth-library';

import {Context} from '../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
  OAuth2Auth,
} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {isTokenExpired} from '../../auth/oauth2/oauth2_utils.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';

import {
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentialsConfig,
} from './bigquery_credentials.js';

/** Google's OAuth2 authorization endpoint. */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';

/** Google's OAuth2 token endpoint. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The prefix of the key the ADK auth plumbing stores the OAuth response under. */
const CREDENTIAL_KEY_PREFIX = 'bigquery_oauth';

/** Whether the client holds an access token that has not expired. */
function isCredentialValid(client: OAuth2Client): boolean {
  return (
    !!client.credentials.access_token &&
    !isTokenExpired({expiresAt: client.credentials.expiry_date ?? undefined})
  );
}

/** Whether the client holds an expired access token and can refresh it. */
function isRefreshable(client: OAuth2Client): boolean {
  return (
    isTokenExpired({expiresAt: client.credentials.expiry_date ?? undefined}) &&
    !!client.credentials.refresh_token
  );
}

/**
 * Appends the client id to a session-state key.
 *
 * Both the OAuth response and the cached token are keyed this way, so two tools
 * configured with different OAuth clients in one session never read each
 * other's grant.
 */
function keyFor(prefix: string, clientId?: string): string {
  return clientId ? `${prefix}_${clientId}` : prefix;
}

/** Builds the OAuth2 authorization-code scheme for the requested scopes. */
function buildAuthScheme(scopes: string[]): AuthScheme {
  return {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        scopes: Object.fromEntries(
          scopes.map((scope) => [scope, `Access to ${scope}`]),
        ),
      },
    },
  };
}

/** Builds the raw credential the end user authorizes the flow with. */
function buildAuthCredential(
  config: BigQueryCredentialsConfig,
): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
  };
}

/**
 * Reduces a credential to the fields that may be cached.
 *
 * Session state is persisted by `DatabaseSessionService` and
 * `VertexAiSessionService`, so the client secret must never reach it.
 */
function toCacheEntry(tokens: OAuth2Auth): OAuth2Auth {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}

/** Builds an OAuth client from a config's identity and a set of tokens. */
function buildClient(
  config: BigQueryCredentialsConfig,
  tokens: OAuth2Auth,
): OAuth2Client {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt,
    scope: config.scopes.join(' '),
  });
  return client;
}

/**
 * Refreshes the client's access token in place.
 *
 * @return Whether the token endpoint returned a new token.
 */
async function refreshCredential(client: OAuth2Client): Promise<boolean> {
  try {
    const {credentials} = await client.refreshAccessToken();
    client.setCredentials(credentials);
    return true;
  } catch (error: unknown) {
    logger.debug(
      `BigQuery credential refresh failed, falling back to the OAuth flow: ${formatError(error)}`,
    );
    return false;
  }
}

/**
 * Resolves a BigQuery OAuth credential for the current end user
 * (experimental).
 *
 * It reuses the credential held by the config, then a token cached in session
 * state, then a refresh of an expired token, and finally the interactive OAuth
 * flow. Several tools sharing one config also share the cached token, so an
 * end user authorizes once per session.
 */
@experimental
export class BigQueryCredentialsManager {
  /**
   * @param credentialsConfig The credential source. The manager writes the
   *     credential it resolves back onto it.
   */
  constructor(readonly credentialsConfig: BigQueryCredentialsConfig) {}

  /**
   * Returns a credential with a usable access token, or `undefined` while the
   * end user has yet to complete the OAuth flow.
   *
   * @param toolContext The context of the tool call, used to read the token
   *     cache and to drive the OAuth flow.
   */
  async getValidCredentials(
    toolContext: Context,
  ): Promise<OAuth2Client | undefined> {
    const client =
      this.credentialsConfig.credentials ?? this.loadCached(toolContext);
    if (client) {
      if (isCredentialValid(client)) {
        return client;
      }
      if (isRefreshable(client) && (await refreshCredential(client))) {
        this.credentialsConfig.credentials = client;
        return client;
      }
    }
    return this.performOAuthFlow(toolContext);
  }

  /** Rehydrates the credential cached in session state, when there is one. */
  private loadCached(toolContext: Context): OAuth2Client | undefined {
    const tokens = toolContext.state.get<OAuth2Auth>(
      keyFor(BIGQUERY_TOKEN_CACHE_KEY, this.credentialsConfig.clientId),
    );
    if (!tokens) {
      return undefined;
    }
    const client = buildClient(this.credentialsConfig, tokens);
    this.credentialsConfig.credentials = client;
    return client;
  }

  /**
   * Completes the OAuth flow when the end user has authorized it, and asks for
   * authorization otherwise.
   */
  private performOAuthFlow(toolContext: Context): OAuth2Client | undefined {
    const config = this.credentialsConfig;
    const authConfig: AuthConfig = {
      authScheme: buildAuthScheme(config.scopes),
      rawAuthCredential: buildAuthCredential(config),
      credentialKey: keyFor(CREDENTIAL_KEY_PREFIX, config.clientId),
    };

    const tokens = toolContext.getAuthResponse(authConfig)?.oauth2;
    if (!tokens) {
      toolContext.requestCredential(authConfig);
      return undefined;
    }

    const client = buildClient(config, tokens);
    config.credentials = client;
    toolContext.state.set(
      keyFor(BIGQUERY_TOKEN_CACHE_KEY, config.clientId),
      toCacheEntry(tokens),
    );
    return client;
  }
}
