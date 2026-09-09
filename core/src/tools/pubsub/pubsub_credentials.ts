/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {AuthCredentialTypes} from '../../auth/auth_credential.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import type {PubSubSdkCredentials, ServiceAccountCredentials} from './sdk.js';

/** OAuth scopes the Pub/Sub tools request when the config names none. */
export const PUBSUB_DEFAULT_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/pubsub',
];

/** Session-state key under which the resolved Pub/Sub grant is cached. */
export const PUBSUB_TOKEN_CACHE_KEY = 'pubsub_token_cache';

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * How the Pub/Sub tools obtain credentials.
 *
 * Leave every field unset to use Application Default Credentials, which is
 * one identity for every end user. Name a service account to pin that
 * identity explicitly. Name an OAuth client to send each end user through the
 * authorization-code flow instead, so each one reaches only their own topics.
 *
 * A service account and an OAuth client cannot both be named; the
 * {@link PubSubToolset} constructor rejects that.
 */
export interface PubSubCredentialsConfig {
  /** A service-account key, as the SDK reads it. */
  credentials?: ServiceAccountCredentials;
  /** Path to a service-account key file, as the SDK reads it. */
  keyFilename?: string;
  /** The OAuth client id to use. */
  clientId?: string;
  /** The OAuth client secret to use. */
  clientSecret?: string;
  /** Scopes to request. Defaults to {@link PUBSUB_DEFAULT_SCOPES}. */
  scopes?: string[];
}

/** The credential fields one tool call builds its Pub/Sub client with. */
export interface ResolvedPubSubCredentials {
  credentials?: PubSubSdkCredentials;
  keyFilename?: string;
  scopes: string[];
}

/**
 * Rejects a config that names both a service credential and an OAuth client,
 * or half an OAuth client.
 *
 * @param config The credentials configuration to check.
 * @throws Error if the config cannot authenticate.
 */
export function validatePubSubCredentialsConfig(
  config: PubSubCredentialsConfig,
): void {
  const {credentials, keyFilename, clientId, clientSecret} = config;
  if (credentials && keyFilename) {
    throw new Error('Provide either credentials or keyFilename, not both.');
  }
  if ((credentials || keyFilename) && (clientId || clientSecret)) {
    throw new Error(
      'If a service account is provided, client_id and client_secret must' +
        ' not be provided.',
    );
  }
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      'Must provide the client_id and client_secret pair together, or' +
        ' neither.',
    );
  }
}

/** Describes the scopes for the OpenAPI security scheme. */
function scopeDescriptions(scopes: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    scopes.map((scope) => [scope, `Access to ${scope}`]),
  );
}

/**
 * Resolves the credentials the Pub/Sub tools call the API with.
 *
 * One manager serves every end user: {@link resolve} reads and writes the
 * caller's own session state, so two users of the same agent never share a
 * grant.
 */
export class PubSubCredentialsManager {
  private readonly scopes: string[];
  /** Set only when the config named a complete OAuth client. */
  private readonly oauth?: {clientId: string; clientSecret: string};

  constructor(private readonly config: PubSubCredentialsConfig) {
    this.scopes = [...(config.scopes ?? PUBSUB_DEFAULT_SCOPES)];
    const {clientId, clientSecret} = config;
    this.oauth =
      clientId && clientSecret ? {clientId, clientSecret} : undefined;
  }

  /**
   * Returns the credentials for this end user, or `undefined` when the user
   * must still complete the OAuth flow. In that case the manager has already
   * asked for the credential through `context.requestCredential`.
   *
   * @param context The calling tool's context. Only the OAuth flow needs one.
   * @return The credentials, or nothing while the user has not authorized.
   * @throws Error if the OAuth flow has no context to read session state
   *   from, or if the grant carries no refresh token.
   */
  resolve(context?: Context): ResolvedPubSubCredentials | undefined {
    const {credentials, keyFilename} = this.config;
    if (credentials) {
      return {credentials, scopes: this.scopes};
    }
    if (keyFilename) {
      return {keyFilename, scopes: this.scopes};
    }
    if (!this.oauth) {
      // Application Default Credentials.
      return {scopes: this.scopes};
    }
    if (!context) {
      throw new Error(
        'A tool context is required to resolve Pub/Sub credentials from' +
          ' session state. Call the tool through an agent.',
      );
    }
    return this.runOAuthFlow(context, this.oauth);
  }

  /**
   * Reads this end user's refresh token, running the authorization flow the
   * first time. Only the refresh token is kept: the SDK mints its own access
   * tokens and cannot present one it was handed.
   *
   * @throws Error if the grant carries no refresh token.
   */
  private runOAuthFlow(
    context: Context,
    oauth: {clientId: string; clientSecret: string},
  ): ResolvedPubSubCredentials | undefined {
    let refreshToken = context.state.get<string>(PUBSUB_TOKEN_CACHE_KEY);
    if (!refreshToken) {
      const authConfig = this.authConfig();
      const oauth2 = context.getAuthResponse(authConfig)?.oauth2;
      if (!oauth2?.accessToken) {
        context.requestCredential(authConfig);
        return undefined;
      }
      if (!oauth2.refreshToken) {
        throw new Error(
          'The authorization did not return a refresh token, which Pub/Sub' +
            ' needs to authenticate as this user. Request offline access.',
        );
      }
      refreshToken = oauth2.refreshToken;
      context.state.set(PUBSUB_TOKEN_CACHE_KEY, refreshToken);
    }
    return {
      credentials: {
        type: 'authorized_user',
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: refreshToken,
      },
      scopes: this.scopes,
    };
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
}
