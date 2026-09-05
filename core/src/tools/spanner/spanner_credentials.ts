/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {AuthCredentialTypes} from '../../auth/auth_credential.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {experimental} from '../../utils/experimental.js';
import {
  BaseGoogleCredentialsConfig,
  type GoogleCredentialsConfigOptions,
} from '../_google_credentials.js';
import {
  createTokenAuthClient,
  SpannerAccessToken,
  SpannerAuthClient,
} from './client.js';

/** Key under which a resolved Spanner token is cached in tool context state. */
export const SPANNER_TOKEN_CACHE_KEY = 'spanner_token_cache';

/** OAuth scopes the Spanner tools request when the caller names none. */
export const SPANNER_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/spanner.admin',
  'https://www.googleapis.com/auth/spanner.data',
];

/**
 * The same scopes as {@link SPANNER_DEFAULT_SCOPE}, under the name
 * `@google/adk/tools/spanner` publishes them as.
 */
export const SPANNER_DEFAULT_SCOPES: readonly string[] = SPANNER_DEFAULT_SCOPE;

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * How the Spanner tools obtain credentials (experimental).
 *
 * The config defaults its scopes to {@link SPANNER_DEFAULT_SCOPE} and caches
 * the resolved token under {@link SPANNER_TOKEN_CACHE_KEY}, so Spanner tools
 * never share a cached token with another Google toolset.
 */
@experimental
export class SpannerCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that two configs never share one mutable array.
      this.scopes = [...SPANNER_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = SPANNER_TOKEN_CACHE_KEY;
  }
}

/**
 * How the Spanner tools obtain credentials, as `SpannerToolset` accepts them.
 * Exactly one of three shapes is valid, which TypeScript cannot express, so
 * the {@link SpannerToolset} constructor enforces it at runtime:
 *
 *   1. `authClient` alone — one identity for every end user.
 *   2. `externalAccessTokenKey` alone — a token another component already
 *      minted and wrote to session state.
 *   3. `clientId` and `clientSecret` (and optionally `scopes`) — each end user
 *      goes through the OAuth authorization-code flow.
 *
 * This is a second port of the same adk-python type as
 * {@link SpannerCredentialsConfig}, which is the class the `@google/adk`
 * barrel publishes. The two cannot share one name in this module, so
 * `@google/adk/tools/spanner` re-exports this one as `SpannerCredentialsConfig`
 * instead. Its `authClient` is typed off the Spanner client's own options,
 * because `@google-cloud/spanner` types that field with the copy of
 * `google-auth-library` that `google-gax` pins.
 */
export interface SpannerToolsetCredentialsConfig {
  /**
   * An auth client the caller already built: Application Default Credentials,
   * a service-account key, or workload identity. Every end user then shares
   * this one identity, so set it only when it may read every user's data.
   *
   * ```ts
   * const authClient = await new GoogleAuth({
   *   scopes: [...SPANNER_DEFAULT_SCOPES],
   * }).getClient();
   * ```
   */
  authClient?: SpannerAuthClient;
  /** Session-state key holding an access token minted elsewhere. */
  externalAccessTokenKey?: string;
  /** The OAuth client id to use. */
  clientId?: string;
  /** The OAuth client secret to use. */
  clientSecret?: string;
  /** Scopes to request. Defaults to {@link SPANNER_DEFAULT_SCOPES}. */
  scopes?: string[];
}

/**
 * Rejects a config that sets more than one of the three credential sources.
 * The messages match adk-python's `BaseGoogleCredentialsConfig.__post_init__`,
 * because they reach the developer who wrote the config.
 *
 * @throws Error if the config names no credential source, or more than one.
 */
export function validateSpannerCredentialsConfig(
  config: SpannerToolsetCredentialsConfig,
): void {
  const {authClient, externalAccessTokenKey, clientId, clientSecret, scopes} =
    config;
  if (authClient) {
    if (externalAccessTokenKey || clientId || clientSecret || scopes) {
      throw new Error(
        'If credentials are provided, external_access_token_key, client_id,' +
          ' client_secret, and scopes must not be provided.',
      );
    }
    return;
  }
  if (externalAccessTokenKey) {
    if (clientId || clientSecret || scopes) {
      throw new Error(
        'If external_access_token_key is provided, client_id,' +
          ' client_secret, and scopes must not be provided.',
      );
    }
    return;
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      'Must provide one of credentials, external_access_token_key, or' +
        ' client_id and client_secret pair.',
    );
  }
}

/** Whether a cached token can still authenticate a call. */
function isUsable(token: SpannerAccessToken): boolean {
  // A refresh token lets google-auth-library mint a new access token itself,
  // so an expired access token is not a reason to re-run the OAuth flow.
  return (
    Boolean(token.refreshToken) ||
    token.expiresAt === undefined ||
    token.expiresAt > Date.now()
  );
}

/** Describes the scopes for the OpenAPI security scheme. */
function scopeDescriptions(scopes: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    scopes.map((scope) => [scope, `Access to ${scope}`]),
  );
}

/**
 * Resolves the credentials the Spanner tools call the Admin API with.
 *
 * One manager serves every end user: {@link getAuthClient} reads and writes
 * the caller's own session state, so two users of the same agent never share a
 * token.
 */
export class SpannerCredentialsManager {
  private readonly scopes: readonly string[];

  constructor(private readonly config: SpannerToolsetCredentialsConfig) {
    this.scopes = config.scopes ?? SPANNER_DEFAULT_SCOPES;
  }

  /**
   * Returns the auth client for this end user, or `undefined` when the user
   * must still complete the OAuth flow. In that case the manager has already
   * asked for the credential through `context.requestCredential`.
   *
   * @param context The calling tool's context. Only a configured `authClient`
   *   resolves without one; the other two sources read session state.
   * @throws Error if the configuration needs a context and there is none, or
   *   if `externalAccessTokenKey` names a key session state does not hold.
   */
  async getAuthClient(
    context?: Context,
  ): Promise<SpannerAuthClient | undefined> {
    const {externalAccessTokenKey, authClient} = this.config;
    if (authClient) {
      // google-auth-library refreshes on use, so there is nothing to renew.
      return authClient;
    }
    if (!context) {
      throw new Error(
        'A tool context is required to resolve Spanner credentials from' +
          ' session state. Call the tool through an agent.',
      );
    }
    if (externalAccessTokenKey) {
      return this.readExternalToken(context, externalAccessTokenKey);
    }
    return this.runOAuthFlow(context);
  }

  private readExternalToken(
    context: Context,
    key: string,
  ): Promise<SpannerAuthClient> {
    const accessToken = context.state.get<string>(key);
    if (!accessToken) {
      throw new Error(
        'external_access_token_key is provided but no access token found in' +
          ` tool_context.state with key ${key}.`,
      );
    }
    return this.buildClient({accessToken});
  }

  private async runOAuthFlow(
    context: Context,
  ): Promise<SpannerAuthClient | undefined> {
    const cached = context.state.get<SpannerAccessToken>(
      SPANNER_TOKEN_CACHE_KEY,
    );
    if (cached && isUsable(cached)) {
      return this.buildClient(cached);
    }

    const authConfig = this.authConfig();
    const response = context.getAuthResponse(authConfig);
    const oauth2 = response?.oauth2;
    if (!oauth2?.accessToken) {
      context.requestCredential(authConfig);
      return undefined;
    }

    const token: SpannerAccessToken = {
      accessToken: oauth2.accessToken,
      refreshToken: oauth2.refreshToken,
      expiresAt: oauth2.expiresAt,
    };
    context.state.set(SPANNER_TOKEN_CACHE_KEY, token);
    return this.buildClient(token);
  }

  private authConfig(): AuthConfig {
    const authScheme: OpenAPIV3.OAuth2SecurityScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: GOOGLE_AUTHORIZATION_URL,
          tokenUrl: GOOGLE_TOKEN_URL,
          scopes: scopeDescriptions(this.scopes),
        },
      },
    };
    return {
      authScheme,
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
        },
      },
      credentialKey: SPANNER_TOKEN_CACHE_KEY,
    };
  }

  private buildClient(token: SpannerAccessToken): Promise<SpannerAuthClient> {
    const {clientId, clientSecret} = this.config;
    return createTokenAuthClient(token, {clientId, clientSecret});
  }
}
