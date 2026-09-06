/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {AuthCredentialTypes} from '../../auth/auth_credential.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {GcsAuthorizedUser, GcsCredentials} from './client.js';

/** Session-state key under which a resolved Cloud Storage token is cached. */
const GCS_TOKEN_CACHE_KEY = 'gcs_token_cache';

/** OAuth scopes the Cloud Storage tools request when the caller names none. */
export const GCS_DEFAULT_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/devstorage.full_control',
];

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * How the Cloud Storage tools obtain credentials. Exactly one of two shapes is
 * valid, which TypeScript cannot express, so the toolset constructor enforces
 * it at runtime:
 *
 *   1. `applicationDefaultCredentials` alone — one identity for every end
 *      user.
 *   2. `clientId` and `clientSecret` (and optionally `scopes`) — each end user
 *      goes through the OAuth authorization-code flow.
 */
export interface GcsCredentialsConfig {
  /**
   * Authenticate every call as the agent's own identity, read from
   * Application Default Credentials by `@google-cloud/storage`.
   *
   * Every end user then shares this one identity, so set it only when that
   * identity may read every user's data. This is the deployment adk-python's
   * `credentials` field documents first: an agent running on Google Cloud
   * whose service account already reaches the buckets.
   */
  applicationDefaultCredentials?: boolean;
  /** The OAuth client id to use. */
  clientId?: string;
  /** The OAuth client secret to use. */
  clientSecret?: string;
  /** Scopes to request. Defaults to {@link GCS_DEFAULT_SCOPES}. */
  scopes?: string[];
}

/** The OAuth client each end user authorizes the tools against. */
export interface GcsOAuthClient {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
}

/**
 * The one credential source {@link validateGcsCredentialsConfig} accepted,
 * with the fields that source needs known to be present.
 */
export type GcsCredentialSource =
  | {applicationDefaultCredentials: true}
  | GcsOAuthClient;

/**
 * Reduces a config to the single credential source it names.
 *
 * This is adk-python's `BaseGoogleCredentialsConfig.__post_init__` rule. The
 * messages name the adk-js options rather than the Python ones, because they
 * reach the developer who wrote the config, and adk-python's own test asserts
 * only that the config is rejected.
 *
 * @param config The config as the developer wrote it.
 * @return The credential source, narrowed so its fields are no longer
 *   optional.
 * @throws Error if the config names no credential source, or more than one.
 */
export function validateGcsCredentialsConfig(
  config: GcsCredentialsConfig,
): GcsCredentialSource {
  const {applicationDefaultCredentials, clientId, clientSecret, scopes} =
    config;
  if (applicationDefaultCredentials) {
    if (clientId || clientSecret || scopes) {
      throw new Error(
        'If applicationDefaultCredentials is set, clientId, clientSecret and' +
          ' scopes must not be provided.',
      );
    }
    return {applicationDefaultCredentials: true};
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      'Must provide either applicationDefaultCredentials, or a clientId and' +
        ' clientSecret pair.',
    );
  }
  return {clientId, clientSecret, scopes: scopes ?? GCS_DEFAULT_SCOPES};
}

/**
 * Resolves the credentials the Cloud Storage tools call the API with.
 *
 * One manager serves every end user: {@link getCredentials} reads and writes
 * the caller's own session state, so two users of the same agent never share
 * a token.
 */
export class GcsCredentialsManager {
  constructor(private readonly source: GcsCredentialSource) {}

  /**
   * Returns the credentials for this end user, or `undefined` when the user
   * must still complete the OAuth flow. In that case the manager has already
   * asked for the credential through `context.requestCredential`.
   *
   * @param context The calling tool's context. Only Application Default
   *   Credentials resolve without one; the OAuth flow reads session state.
   * @throws Error if the configuration needs a context and there is none, or
   *   if the completed OAuth flow returned no refresh token.
   */
  async getCredentials(context?: Context): Promise<GcsCredentials | undefined> {
    const source = this.source;
    if ('applicationDefaultCredentials' in source) {
      // Storage reads and refreshes the identity itself.
      return {applicationDefaultCredentials: true};
    }
    if (!context) {
      throw new Error(
        'A tool context is required to resolve Cloud Storage credentials from' +
          ' session state. Call the tool through an agent.',
      );
    }
    return this.runOAuthFlow(source, context);
  }

  private async runOAuthFlow(
    source: GcsOAuthClient,
    context: Context,
  ): Promise<GcsCredentials | undefined> {
    const cached = context.state.get<GcsAuthorizedUser>(GCS_TOKEN_CACHE_KEY);
    // The refresh token lets storage mint a new access token itself, so an
    // expired access token is not a reason to re-run the OAuth flow.
    if (cached?.refreshToken) {
      return {authorizedUser: cached};
    }

    const authConfig = authConfigFor(source);
    const oauth2 = context.getAuthResponse(authConfig)?.oauth2;
    if (!oauth2?.accessToken) {
      context.requestCredential(authConfig);
      return undefined;
    }
    if (!oauth2.refreshToken) {
      throw new Error(
        'The authorization flow returned no refresh token, which' +
          ' @google-cloud/storage requires to authenticate. Request offline' +
          ' access, or set applicationDefaultCredentials instead.',
      );
    }

    const authorizedUser: GcsAuthorizedUser = {
      clientId: source.clientId,
      clientSecret: source.clientSecret,
      refreshToken: oauth2.refreshToken,
      accessToken: oauth2.accessToken,
      expiresAt: oauth2.expiresAt,
    };
    context.state.set(GCS_TOKEN_CACHE_KEY, authorizedUser);
    return {authorizedUser};
  }
}

/** The authorization-code flow the Cloud Storage tools send an end user to. */
function authConfigFor(source: GcsOAuthClient): AuthConfig {
  const authScheme: OpenAPIV3.OAuth2SecurityScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: GOOGLE_AUTHORIZATION_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        scopes: Object.fromEntries(
          source.scopes.map((scope) => [scope, `Access to ${scope}`]),
        ),
      },
    },
  };
  return {
    authScheme,
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: source.clientId, clientSecret: source.clientSecret},
    },
    credentialKey: GCS_TOKEN_CACHE_KEY,
  };
}
