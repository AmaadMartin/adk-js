/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuth2Client} from 'google-auth-library';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {AuthCredentialTypes} from '../../auth/auth_credential.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {PubSubAuthClient} from './client.js';

/** OAuth scopes the Pub/Sub tools request when the config names none. */
export const PUBSUB_DEFAULT_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/pubsub',
];

/** Session-state key under which the resolved Pub/Sub token is cached. */
export const PUBSUB_TOKEN_CACHE_KEY = 'pubsub_token_cache';

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * How the Pub/Sub tools obtain credentials. Exactly one of three shapes is
 * valid, which TypeScript cannot express, so the {@link PubSubToolset}
 * constructor enforces it at runtime:
 *
 *   1. `authClient` alone — one identity for every end user.
 *   2. `externalAccessTokenKey` alone — a token another component already
 *      minted and wrote to session state.
 *   3. `clientId` and `clientSecret` (and optionally `scopes`) — each end user
 *      goes through the OAuth authorization-code flow.
 */
export interface PubSubCredentialsConfig {
  /**
   * An auth client the caller already built: Application Default Credentials,
   * a service-account key, or workload identity. Every end user then shares
   * this one identity, so set it only when it may reach every user's topics
   * and subscriptions.
   *
   * ```ts
   * const authClient = await new GoogleAuth({
   *   scopes: [...PUBSUB_DEFAULT_SCOPES],
   * }).getClient();
   * ```
   */
  authClient?: PubSubAuthClient;
  /** Session-state key holding an access token minted elsewhere. */
  externalAccessTokenKey?: string;
  /** The OAuth client id to use. */
  clientId?: string;
  /** The OAuth client secret to use. */
  clientSecret?: string;
  /** Scopes to request. Defaults to {@link PUBSUB_DEFAULT_SCOPES}. */
  scopes?: string[];
}

/** An OAuth access token, as cached in session state. */
export interface PubSubAccessToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` expires, if known. */
  expiresAt?: number;
}

/**
 * Rejects a config that sets more than one of the three credential sources.
 * The messages match adk-python's `BaseGoogleCredentialsConfig.__post_init__`,
 * because they reach the developer who wrote the config.
 *
 * @param config The credentials configuration to check.
 * @throws Error if the config names no credential source, or more than one.
 */
export function validatePubSubCredentialsConfig(
  config: PubSubCredentialsConfig,
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
function isUsable(token: PubSubAccessToken): boolean {
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
 * Builds an auth client that presents `token` to Pub/Sub.
 *
 * @param token The access token, and the refresh token when there is one.
 * @param clientId The OAuth client id the refresh token is renewed against.
 * @param clientSecret The matching OAuth client secret.
 * @return The auth client.
 */
function createTokenAuthClient(
  token: PubSubAccessToken,
  clientId?: string,
  clientSecret?: string,
): OAuth2Client {
  const client = new OAuth2Client({clientId, clientSecret});
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt,
  });
  return client;
}

/**
 * Resolves the credentials the Pub/Sub tools call the API with.
 *
 * One manager serves every end user: {@link getAuthClient} reads and writes
 * the caller's own session state, so two users of the same agent never share
 * a token.
 */
export class PubSubCredentialsManager {
  private readonly scopes: readonly string[];

  constructor(private readonly config: PubSubCredentialsConfig) {
    this.scopes = config.scopes ?? PUBSUB_DEFAULT_SCOPES;
  }

  /**
   * Returns the auth client for this end user, or `undefined` when the user
   * must still complete the OAuth flow. In that case the manager has already
   * asked for the credential through `context.requestCredential`.
   *
   * @param context The calling tool's context. Only a configured `authClient`
   *   resolves without one; the other two sources read session state.
   * @return The auth client, or nothing while the user has not authorized.
   * @throws Error if the configuration needs a context and there is none, or
   *   if `externalAccessTokenKey` names a key session state does not hold.
   */
  async getAuthClient(
    context?: Context,
  ): Promise<PubSubAuthClient | undefined> {
    const {externalAccessTokenKey, authClient} = this.config;
    if (authClient) {
      // google-auth-library refreshes on use, so there is nothing to renew.
      return authClient;
    }
    if (!context) {
      throw new Error(
        'A tool context is required to resolve Pub/Sub credentials from' +
          ' session state. Call the tool through an agent.',
      );
    }
    if (externalAccessTokenKey) {
      return this.readExternalToken(context, externalAccessTokenKey);
    }
    return this.runOAuthFlow(context);
  }

  private readExternalToken(context: Context, key: string): PubSubAuthClient {
    const accessToken = context.state.get<string>(key);
    if (!accessToken) {
      throw new Error(
        'external_access_token_key is provided but no access token found in' +
          ` tool_context.state with key ${key}.`,
      );
    }
    return this.buildClient({accessToken});
  }

  private runOAuthFlow(context: Context): PubSubAuthClient | undefined {
    const cached = context.state.get<PubSubAccessToken>(PUBSUB_TOKEN_CACHE_KEY);
    if (cached && isUsable(cached)) {
      return this.buildClient(cached);
    }

    const authConfig = this.authConfig();
    const oauth2 = context.getAuthResponse(authConfig)?.oauth2;
    if (!oauth2?.accessToken) {
      context.requestCredential(authConfig);
      return undefined;
    }

    const token: PubSubAccessToken = {
      accessToken: oauth2.accessToken,
      refreshToken: oauth2.refreshToken,
      expiresAt: oauth2.expiresAt,
    };
    context.state.set(PUBSUB_TOKEN_CACHE_KEY, token);
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
      credentialKey: PUBSUB_TOKEN_CACHE_KEY,
    };
  }

  private buildClient(token: PubSubAccessToken): PubSubAuthClient {
    const {clientId, clientSecret} = this.config;
    return createTokenAuthClient(token, clientId, clientSecret);
  }
}
