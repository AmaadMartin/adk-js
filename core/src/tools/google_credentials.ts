/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, OAuth2Client} from 'google-auth-library';
import {OpenAPIV3} from 'openapi-types';

import {Context} from '../agents/context.js';
import {AuthCredentialTypes} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {asRecord, formatError, readHttpStatus} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';

/** Google's OAuth2 authorization endpoint. */
const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';

/** Google's OAuth2 token endpoint. */
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** `AuthConfig.credentialKey` used when the config declares no token cache key. */
const DEFAULT_GOOGLE_CREDENTIAL_KEY = 'google_credentials';

/** The OAuth2 error code returned for a refresh token that no longer works. */
const INVALID_GRANT = 'invalid_grant';

/**
 * The authorized-user token cache, in the JSON shape adk-python writes
 * (`google.oauth2.credentials.Credentials.to_json()`), so that a session
 * written by either SDK is readable by the other. Keys stay snake_case for
 * that reason; `expiry` is an ISO-8601 UTC string.
 */
interface TokenCachePayload {
  token?: string | null;
  refresh_token?: string | null;
  token_uri: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  expiry?: string;
}

/** Options for {@link BaseGoogleCredentialsConfig}. */
export interface BaseGoogleCredentialsConfigOptions {
  /**
   * A pre-built auth client to use for every end user, so that no end user
   * goes through the OAuth flow. Application Default Credentials, a service
   * account key, or an authorized user. Mutually exclusive with
   * `externalAccessTokenKey`, `clientId`, `clientSecret` and `scopes`.
   */
  credentials?: AuthClient;
  /**
   * Session-state key holding a bare access token supplied by the host
   * application. Mutually exclusive with `credentials`, `clientId`,
   * `clientSecret` and `scopes`.
   */
  externalAccessTokenKey?: string;
  /** The OAuth client id to run the authorization flow with. */
  clientId?: string;
  /** The OAuth client secret to run the authorization flow with. */
  clientSecret?: string;
  /** The OAuth scopes to request. */
  scopes?: string[];
  /**
   * Session-state key under which the resolved token cache is stored. Each
   * toolset sets its own, so two toolsets never share a token. When it is
   * unset, nothing is written to session state.
   */
  tokenCacheKey?: string;
}

/**
 * Declarative Google credential configuration for a {@link GoogleTool}
 * (experimental).
 *
 * Exactly one of three combinations is valid: a pre-built `credentials`
 * client, an `externalAccessTokenKey`, or a `clientId` and `clientSecret`
 * pair. The constructor rejects anything else.
 */
@experimental
export class BaseGoogleCredentialsConfig {
  readonly credentials?: AuthClient;
  readonly externalAccessTokenKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: string[];
  readonly tokenCacheKey?: string;

  constructor(options: BaseGoogleCredentialsConfigOptions) {
    validateCredentialsOptions(options);
    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.tokenCacheKey = options.tokenCacheKey;

    // An authorized-user client already carries the OAuth identity the flow
    // would need, so adopt it. Mirrors adk-python, which copies the same three
    // fields off a `google.oauth2.credentials.Credentials`.
    const identity = options.credentials
      ? readClientIdentity(options.credentials)
      : undefined;
    this.clientId = identity?.clientId ?? options.clientId;
    this.clientSecret = identity?.clientSecret ?? options.clientSecret;
    this.scopes = identity?.scopes ?? options.scopes;
  }
}

/**
 * Resolves a {@link BaseGoogleCredentialsConfig} into a live auth client for
 * one tool invocation.
 *
 * The manager reads and writes the token cache in session state, refreshes an
 * expired token, and drives the ADK OAuth flow when the end user has to
 * authorize interactively. Several tools may share one manager, so that they
 * share an authenticated session instead of each running its own flow.
 */
@experimental
export class GoogleCredentialsManager {
  constructor(readonly credentialsConfig: BaseGoogleCredentialsConfig) {}

  /**
   * Returns a client the caller can authenticate with, or `undefined` when an
   * interactive authorization has just been requested and the call must be
   * retried once the end user completes it.
   *
   * @param toolContext The context of the tool call, used for session state
   *     and the OAuth flow.
   * @return The resolved auth client, or `undefined` while authorization is in
   *     flight.
   */
  async getValidCredentials(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    const config = this.credentialsConfig;
    if (config.externalAccessTokenKey) {
      return createAuthorizedUserClient({
        accessToken: readExternalAccessToken(
          toolContext,
          config.externalAccessTokenKey,
        ),
      });
    }

    const client = this.readTokenCache(toolContext) ?? config.credentials;
    if (client && !isReauthorizableCredential(client)) {
      return refreshUnattendedCredential(client);
    }

    if (client && hasUsableAccessToken(client)) {
      return client;
    }

    if (client && (await refreshReauthorizableCredential(client))) {
      this.writeTokenCache(toolContext, client);
      return client;
    }

    return this.performOAuthFlow(toolContext);
  }

  /** Builds the client described by the cached token, when there is one. */
  private readTokenCache(toolContext: Context): AuthClient | undefined {
    const key = this.credentialsConfig.tokenCacheKey;
    const cached = key ? toolContext.state.get<string>(key) : undefined;
    if (!cached) {
      return undefined;
    }
    const payload = asRecord(JSON.parse(cached));
    return createAuthorizedUserClient({
      accessToken: asString(payload?.['token']),
      refreshToken: asString(payload?.['refresh_token']),
      clientId: asString(payload?.['client_id']),
      clientSecret: asString(payload?.['client_secret']),
      scopes:
        this.credentialsConfig.scopes ?? readStringArray(payload, 'scopes'),
      // An entry that recorded no expiry counts as already expired, so the
      // token is refreshed instead of served forever. adk-python's
      // `from_authorized_user_info` does the same ("auto-expire if not
      // saved"), which also keeps a cache written by that SDK readable here.
      expiryDate: parseExpiry(asString(payload?.['expiry'])) ?? Date.now(),
    });
  }

  /** Stores the client's token, but only when a cache key is configured. */
  private writeTokenCache(toolContext: Context, client: AuthClient): void {
    const key = this.credentialsConfig.tokenCacheKey;
    if (!key) {
      return;
    }
    toolContext.state.set(
      key,
      serializeTokenCache(client, this.credentialsConfig),
    );
  }

  /**
   * Completes an authorization the end user has already granted, or requests
   * one and returns `undefined`.
   */
  private async performOAuthFlow(
    toolContext: Context,
  ): Promise<AuthClient | undefined> {
    const authConfig = this.buildAuthConfig();
    const authResponse = toolContext.getAuthResponse(authConfig);
    if (!authResponse?.oauth2) {
      toolContext.requestCredential(authConfig);
      return undefined;
    }

    const client = createAuthorizedUserClient({
      accessToken: authResponse.oauth2.accessToken,
      refreshToken: authResponse.oauth2.refreshToken,
      clientId: this.credentialsConfig.clientId,
      clientSecret: this.credentialsConfig.clientSecret,
      scopes: this.credentialsConfig.scopes,
      // `AuthCredential.oauth2.expiresAt` is epoch milliseconds, as
      // `auth/oauth2/oauth2_utils.ts` writes it. Without it the token is
      // cached with no lifetime and never refreshed.
      expiryDate: authResponse.oauth2.expiresAt,
    });
    this.writeTokenCache(toolContext, client);
    return client;
  }

  /** The Google authorization-code flow this config asks the user to run. */
  private buildAuthConfig(): AuthConfig {
    const scopes = this.credentialsConfig.scopes ?? [];
    const authScheme: OpenAPIV3.OAuth2SecurityScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: GOOGLE_OAUTH_AUTH_URL,
          tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
          scopes: Object.fromEntries(
            scopes.map((scope) => [scope, `Access to ${scope}`]),
          ),
        },
      },
    };
    return {
      authScheme,
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: this.credentialsConfig.clientId,
          clientSecret: this.credentialsConfig.clientSecret,
        },
      },
      credentialKey:
        this.credentialsConfig.tokenCacheKey ?? DEFAULT_GOOGLE_CREDENTIAL_KEY,
    };
  }
}

/** Rejects any combination of options that is not one of the three valid ones. */
function validateCredentialsOptions(
  options: BaseGoogleCredentialsConfigOptions,
): void {
  const hasOAuthOptions = Boolean(
    options.clientId || options.clientSecret || options.scopes,
  );
  if (options.credentials) {
    if (options.externalAccessTokenKey || hasOAuthOptions) {
      throw new Error(
        'If credentials are provided, externalAccessTokenKey, clientId, ' +
          'clientSecret, and scopes must not be provided.',
      );
    }
    return;
  }
  if (options.externalAccessTokenKey) {
    if (hasOAuthOptions) {
      throw new Error(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
          'scopes must not be provided.',
      );
    }
    return;
  }
  if (!options.clientId || !options.clientSecret) {
    throw new Error(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  }
}

/** Reads the host-supplied access token, which must already be in state. */
function readExternalAccessToken(toolContext: Context, key: string): string {
  const accessToken = toolContext.state.get<string>(key);
  if (!accessToken) {
    throw new Error(
      'externalAccessTokenKey is provided but no access token found in ' +
        `toolContext.state with key ${key}.`,
    );
  }
  return accessToken;
}

/**
 * Whether ADK can re-authorize this credential: an authorized-user credential
 * carries a refresh token, so an expired one can be refreshed and — if that
 * fails — replaced by a fresh interactive authorization. A service-account,
 * ADC or metadata credential has none and is the caller's to manage: ADK
 * refreshes it best-effort and hands it back.
 */
function isReauthorizableCredential(client: AuthClient): boolean {
  return typeof client.credentials.refresh_token === 'string';
}

/** Whether the client holds a token that is neither absent nor about to expire. */
function hasUsableAccessToken(client: AuthClient): boolean {
  const {access_token: accessToken, expiry_date: expiryDate} =
    client.credentials;
  if (!accessToken) {
    return false;
  }
  if (!expiryDate) {
    return true;
  }
  return expiryDate - Date.now() > client.eagerRefreshThresholdMillis;
}

/**
 * Refreshes a credential ADK cannot re-authorize, and returns it either way.
 * A library that manages its own refresh may still accept a credential ADK
 * failed to refresh, so a failure here is not fatal.
 */
async function refreshUnattendedCredential(
  client: AuthClient,
): Promise<AuthClient> {
  if (hasUsableAccessToken(client)) {
    return client;
  }
  try {
    await client.getAccessToken();
  } catch {
    // Deliberately ignored: the caller's library may refresh it internally.
  }
  return client;
}

/**
 * Refreshes an authorized-user credential.
 *
 * @return Whether the refresh produced a usable token. `false` means the token
 *     endpoint rejected the refresh token, so the end user has to authorize
 *     again. Any other failure propagates to the caller.
 */
async function refreshReauthorizableCredential(
  client: AuthClient,
): Promise<boolean> {
  try {
    await client.getAccessToken();
  } catch (error: unknown) {
    if (isTokenEndpointRejection(error)) {
      return false;
    }
    throw error;
  }
  return hasUsableAccessToken(client);
}

/**
 * Whether the token endpoint refused the refresh token, as opposed to the
 * refresh failing for an unrelated reason such as a network fault.
 */
function isTokenEndpointRejection(error: unknown): boolean {
  const status = readHttpStatus(error);
  if (status !== undefined) {
    return status >= 400 && status < 500;
  }
  return formatError(error).includes(INVALID_GRANT);
}

/** The OAuth identity an authorized-user client carries, when it carries one. */
function readClientIdentity(client: AuthClient):
  | {
      clientId?: string;
      clientSecret?: string;
      scopes?: string[];
    }
  | undefined {
  const clientId =
    '_clientId' in client ? asString(client._clientId) : undefined;
  const clientSecret =
    '_clientSecret' in client ? asString(client._clientSecret) : undefined;
  if (!clientId && !clientSecret) {
    return undefined;
  }
  return {
    clientId,
    clientSecret,
    scopes: splitScopes(client.credentials.scope),
  };
}

/** Builds an authorized-user client from stored or freshly granted material. */
function createAuthorizedUserClient(options: {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  expiryDate?: number;
}): AuthClient {
  const client = new OAuth2Client({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  });
  client.setCredentials({
    access_token: options.accessToken,
    refresh_token: options.refreshToken,
    expiry_date: options.expiryDate,
    scope: options.scopes?.join(' '),
  });
  return client;
}

/** Renders the client's token in the shape {@link TokenCachePayload} describes. */
function serializeTokenCache(
  client: AuthClient,
  config: BaseGoogleCredentialsConfig,
): string {
  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
    scope,
  } = client.credentials;
  const payload: TokenCachePayload = {
    token: accessToken,
    refresh_token: refreshToken,
    token_uri: GOOGLE_OAUTH_TOKEN_URL,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scopes: splitScopes(scope),
    expiry: expiryDate ? new Date(expiryDate).toISOString() : undefined,
  };
  return JSON.stringify(payload);
}

/** Splits the space-delimited scope string the auth library stores. */
function splitScopes(scope: string | undefined): string[] | undefined {
  return scope ? scope.split(' ') : undefined;
}

/** Converts an ISO-8601 expiry to epoch milliseconds. */
function parseExpiry(expiry: string | undefined): number | undefined {
  if (!expiry) {
    return undefined;
  }
  const parsed = Date.parse(expiry);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Narrows an unknown value to a string, treating any other type as unknown. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads an array-of-strings field, dropping any member that is not a string. */
function readStringArray(
  record: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((member): member is string => typeof member === 'string')
    : undefined;
}
