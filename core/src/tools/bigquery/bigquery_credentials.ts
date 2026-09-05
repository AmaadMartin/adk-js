/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {AuthCredentialTypes, OAuth2Auth} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';

/** Session state key holding the OAuth credential the tools reuse. */
export const BIGQUERY_TOKEN_CACHE_KEY = 'bigquery_token_cache';

/** The {@link AuthConfig} credential key the BigQuery tools request under. */
export const BIGQUERY_CREDENTIAL_KEY = 'bigquery_credential';

/** The OAuth scopes requested when the caller supplies none. */
export const DEFAULT_BIGQUERY_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
];

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * How the BigQuery tools obtain an OAuth credential.
 *
 * Either an existing credential used for every end user, or the OAuth client
 * id and secret that drive an interactive flow — never both. Supply
 * `credentials` when the agent already holds a credential with access to every
 * end user's data. Supply `clientId` and `clientSecret` when each end user has
 * to grant access to their own data.
 */
export type BigQueryCredentialsConfig =
  | {
      credentials: OAuth2Auth;
      clientId?: undefined;
      clientSecret?: undefined;
      scopes?: undefined;
    }
  | {
      credentials?: undefined;
      clientId: string;
      clientSecret: string;
      scopes?: string[];
    };

/**
 * The OAuth credential a BigQuery tool runs with, as cached in session state.
 *
 * It carries a refresh token rather than an access token. The tools hand
 * BigQuery an `authorized_user` credential, and the client library mints and
 * renews access tokens from that refresh token itself.
 */
export interface BigQueryCredentials {
  /** The OAuth client id the refresh token was issued to. */
  clientId: string;
  /** The OAuth client secret. */
  clientSecret: string;
  /** The refresh token the client library exchanges for access tokens. */
  refreshToken: string;
}

/** Builds the OAuth2 authorization-code scheme covering `scopes`. */
function buildAuthScheme(scopes: string[]): AuthScheme {
  return {
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
}

/**
 * Reads the three fields an authorized-user credential needs out of an
 * {@link OAuth2Auth}.
 *
 * @param oauth2 The OAuth2 credential to read.
 * @param source Where the credential came from, used in the error message.
 * @return The credential the BigQuery client authenticates with.
 * @throws If the client id, the client secret or the refresh token is absent.
 */
function toBigQueryCredentials(
  oauth2: OAuth2Auth,
  source: string,
): BigQueryCredentials {
  const {clientId, clientSecret, refreshToken} = oauth2;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `${source} must carry a clientId, a clientSecret and a refreshToken. ` +
        'BigQuery authenticates as an authorized user, so request offline ' +
        'access to get a refresh token back.',
    );
  }
  return {clientId, clientSecret, refreshToken};
}

/** What the interactive authorization flow needs to ask for a credential. */
interface BigQueryOAuthFlow {
  authScheme: AuthScheme;
  clientId: string;
  clientSecret: string;
}

/**
 * Resolves the OAuth credential the BigQuery tools run with, and drives the
 * interactive authorization flow when no usable credential exists yet.
 *
 * The resolved credential is cached in session state under
 * {@link BIGQUERY_TOKEN_CACHE_KEY}, so every tool in a session shares one
 * authorization. That is where adk-python caches it too.
 */
export class BigQueryCredentialsManager {
  /** Set when the caller supplied a credential; then no flow ever runs. */
  private readonly configuredCredentials?: BigQueryCredentials;
  /** Set when the caller supplied a client pair; then the flow runs. */
  private readonly flow?: BigQueryOAuthFlow;

  /**
   * @param config The credential the tools authenticate with.
   * @throws If neither a credential nor a client id and secret are given, or
   *   if both are.
   */
  constructor(config: BigQueryCredentialsConfig) {
    // The union type states these two rules at compile time, but a JavaScript
    // caller can still defeat it, so they are enforced here as well.
    if (config.credentials) {
      if (config.clientId || config.clientSecret || config.scopes) {
        throw new Error(
          'BigQueryCredentialsConfig cannot provide both existing ' +
            'credentials and clientId, clientSecret or scopes.',
        );
      }
      this.configuredCredentials = toBigQueryCredentials(
        config.credentials,
        'BigQueryCredentialsConfig.credentials',
      );
      return;
    }

    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        'BigQueryCredentialsConfig must provide either credentials, or a ' +
          'clientId and clientSecret pair.',
      );
    }
    this.flow = {
      authScheme: buildAuthScheme(config.scopes ?? DEFAULT_BIGQUERY_SCOPES),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
  }

  /**
   * Returns the credential to call BigQuery with.
   *
   * @param context The tool context, used for the OAuth flow and its state.
   * @return The credential, or `undefined` while the end user still has to
   *   complete the authorization flow.
   * @throws If the completed authorization flow returned no refresh token.
   */
  async getValidCredentials(
    context: Context,
  ): Promise<BigQueryCredentials | undefined> {
    const cached = context.state.get<BigQueryCredentials>(
      BIGQUERY_TOKEN_CACHE_KEY,
    );
    if (cached) {
      return cached;
    }

    const flow = this.flow;
    if (!flow) {
      return this.configuredCredentials;
    }

    const authConfig: AuthConfig = {
      authScheme: flow.authScheme,
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: flow.clientId, clientSecret: flow.clientSecret},
      },
      credentialKey: BIGQUERY_CREDENTIAL_KEY,
    };

    const authResponse = context.getAuthResponse(authConfig);
    if (!authResponse?.oauth2) {
      context.requestCredential(authConfig);
      return undefined;
    }

    const credentials = toBigQueryCredentials(
      {
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        refreshToken: authResponse.oauth2.refreshToken,
      },
      'The BigQuery authorization response',
    );
    context.state.set(BIGQUERY_TOKEN_CACHE_KEY, credentials);

    return credentials;
  }
}
