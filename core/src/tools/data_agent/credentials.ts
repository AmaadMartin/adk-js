/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth} from 'google-auth-library';

import {Context} from '../../agents/context.js';

/** Scopes requested when the caller does not supply its own. */
export const DATA_AGENT_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
];

/** Configures how {@link DataAgentCredentialsConfig} authenticates a request. */
export interface DataAgentCredentialsConfigOptions {
  /**
   * A pre-built `google-auth-library` client, for example a service account or
   * an impersonated client. Cannot be combined with
   * {@link externalAccessTokenKey}.
   */
  authClient?: AuthClient;

  /**
   * OAuth scopes requested from Application Default Credentials. Defaults to
   * {@link DATA_AGENT_DEFAULT_SCOPES}. Cannot be combined with
   * {@link externalAccessTokenKey}, which carries its own scopes.
   */
  scopes?: string[];

  /**
   * Key in the tool context state that holds an end-user access token. When
   * set, that token authenticates every request and no client is built.
   */
  externalAccessTokenKey?: string;
}

/**
 * Resolves the credentials the data agent tools send to the Gemini Data
 * Analytics API.
 *
 * Exactly one of three paths applies, in order: an access token read from the
 * tool context state, a caller-supplied auth client, or Application Default
 * Credentials.
 */
export class DataAgentCredentialsConfig {
  /** The OAuth scopes requested from Application Default Credentials. */
  readonly scopes: string[];

  private readonly authClient?: AuthClient;
  private readonly externalAccessTokenKey?: string;
  private readonly auth: GoogleAuth;

  constructor(options: DataAgentCredentialsConfigOptions = {}) {
    if (options.authClient && options.externalAccessTokenKey) {
      throw new Error(
        'Cannot set both authClient and externalAccessTokenKey: an external ' +
          'access token authenticates the request on its own.',
      );
    }
    if (options.externalAccessTokenKey && options.scopes) {
      throw new Error(
        'Cannot set both scopes and externalAccessTokenKey: an external ' +
          'access token already carries its own scopes.',
      );
    }

    this.authClient = options.authClient;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.scopes = options.scopes ?? DATA_AGENT_DEFAULT_SCOPES;
    this.auth = new GoogleAuth({scopes: this.scopes});
  }

  /**
   * Builds the authorization headers for one request.
   *
   * @param url The request URL, used to scope self-signed JWT credentials.
   * @param toolContext The tool context, required only when this config reads
   *     an external access token out of the session state.
   * @return A fresh, mutable set of headers.
   */
  async getRequestHeaders(
    url: string,
    toolContext?: Context,
  ): Promise<Headers> {
    if (this.externalAccessTokenKey) {
      const token = toolContext?.state.get<string>(this.externalAccessTokenKey);
      if (!token) {
        throw new Error(
          `No access token found in the tool context state under the key ` +
            `"${this.externalAccessTokenKey}".`,
        );
      }
      return new Headers({Authorization: `Bearer ${token}`});
    }

    if (this.authClient) {
      return this.authClient.getRequestHeaders(url);
    }

    // GoogleAuth caches the client it builds and does not cache a failed
    // lookup, so there is nothing to memoise here.
    return (await this.auth.getClient()).getRequestHeaders(url);
  }
}
