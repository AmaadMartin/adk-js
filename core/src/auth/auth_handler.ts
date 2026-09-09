/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from '../sessions/state.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';

/**
 * The keys that mark a stored object as a credential.
 *
 * `authType` alone is too strict: a client answering an
 * `adk_request_credential` call may send only the payload, so
 * `parseAndStoreAuthResponse` stores a credential such as `{apiKey: '...'}`.
 */
const CREDENTIAL_KEYS: ReadonlyArray<keyof AuthCredential> = [
  'authType',
  'apiKey',
  'http',
  'oauth2',
  'serviceAccount',
];

/** Whether a state value is shaped like a stored credential. */
function isAuthCredential(value: unknown): value is AuthCredential {
  return (
    typeof value === 'object' &&
    value !== null &&
    CREDENTIAL_KEYS.some((key) => key in value)
  );
}

/** Wraps a bare token string in the credential shape the auth scheme implies. */
function buildCredentialFromString(
  token: string,
  authScheme: AuthScheme,
): AuthCredential {
  if (authScheme.type === 'apiKey') {
    return {authType: AuthCredentialTypes.API_KEY, apiKey: token};
  }
  if (authScheme.type === 'http') {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: authScheme.scheme || 'bearer',
        credentials: {token},
      },
    };
  }
  return {authType: AuthCredentialTypes.OAUTH2, oauth2: {accessToken: token}};
}

/** Normalizes the value of one state slot into a credential. */
function toAuthCredential(
  value: unknown,
  authScheme: AuthScheme,
): AuthCredential | undefined {
  if (typeof value === 'string') {
    return value ? buildCredentialFromString(value, authScheme) : undefined;
  }
  return isAuthCredential(value) ? value : undefined;
}

/**
 * A handler that handles the auth flow in Agent Development Kit to help
 * orchestrates the credential request and response flow (e.g. OAuth flow)
 * This class should only be used by Agent Development Kit.
 */
export class AuthHandler {
  constructor(private readonly authConfig: AuthConfig) {}

  /**
   * Reads the credential for this auth config out of the session state.
   *
   * The `temp:` slot that the interactive flow writes wins. When that slot
   * holds nothing usable, the prefixless slot that
   * `SessionStateCredentialService` and application code write is read
   * instead. A bare token string in either slot is wrapped according to the
   * auth scheme.
   */
  getAuthResponse(state: State): AuthCredential | undefined {
    const credentialKey = this.authConfig.credentialKey;
    if (!credentialKey) {
      return undefined;
    }

    const authScheme = this.authConfig.authScheme;

    return (
      toAuthCredential(state.get('temp:' + credentialKey), authScheme) ??
      toAuthCredential(state.get(credentialKey), authScheme)
    );
  }

  /**
   * Stores the exchanged credential in the session state.
   *
   * @param state The session state to store the credential in.
   * @throws Error: If the auth config has no credentialKey.
   */
  async parseAndStoreAuthResponse(state: State): Promise<void> {
    if (!this.authConfig.credentialKey) {
      throw new Error('credentialKey is empty.');
    }

    const credentialKey = 'temp:' + this.authConfig.credentialKey;

    const authSchemeType = this.authConfig.authScheme.type;
    if (!['oauth2', 'openIdConnect'].includes(authSchemeType)) {
      state.set(credentialKey, this.authConfig.exchangedAuthCredential);

      return;
    }

    if (this.authConfig.exchangedAuthCredential) {
      const exchanger = new OAuth2CredentialExchanger();
      const exchangedCredential = await exchanger.exchange({
        authCredential: this.authConfig.exchangedAuthCredential,
        authScheme: this.authConfig.authScheme,
      });
      state.set(credentialKey, exchangedCredential.credential);
    }
  }

  generateAuthRequest(): AuthConfig {
    const authSchemeType = this.authConfig.authScheme.type;

    if (!['oauth2', 'openIdConnect'].includes(authSchemeType)) {
      return this.authConfig;
    }

    if (this.authConfig.exchangedAuthCredential?.oauth2?.authUri) {
      return this.authConfig;
    }

    if (!this.authConfig.rawAuthCredential) {
      throw new Error(`Auth Scheme ${authSchemeType} requires authCredential.`);
    }

    if (!this.authConfig.rawAuthCredential.oauth2) {
      throw new Error(
        `Auth Scheme ${authSchemeType} requires oauth2 in authCredential.`,
      );
    }

    if (this.authConfig.rawAuthCredential.oauth2.authUri) {
      return {
        credentialKey: this.authConfig.credentialKey,
        authScheme: this.authConfig.authScheme,
        rawAuthCredential: this.authConfig.rawAuthCredential,
        exchangedAuthCredential: this.authConfig.rawAuthCredential,
      };
    }

    if (
      !this.authConfig.rawAuthCredential.oauth2.clientId ||
      !this.authConfig.rawAuthCredential.oauth2.clientSecret
    ) {
      throw new Error(
        `Auth Scheme ${authSchemeType} requires both clientId and clientSecret in authCredential.oauth2.`,
      );
    }

    return {
      credentialKey: this.authConfig.credentialKey,
      authScheme: this.authConfig.authScheme,
      rawAuthCredential: this.authConfig.rawAuthCredential,
      exchangedAuthCredential: this.generateAuthUri(),
    };
  }

  /**
   * Generates an response containing the auth uri for user to sign in.
   *
   * @return An AuthCredential object containing the auth URI and state.
   * @throws Error: If the authorization endpoint is not configured in the
   *     auth scheme.
   */
  generateAuthUri(): AuthCredential | undefined {
    const authScheme = this.authConfig.authScheme;
    const authCredential = this.authConfig.rawAuthCredential;

    if (!authCredential || !authCredential.oauth2) {
      return authCredential;
    }

    let authorizationEndpoint = '';
    let scopes: string[] = [];

    if ('authorizationEndpoint' in authScheme) {
      authorizationEndpoint = authScheme.authorizationEndpoint;
      scopes = authScheme.scopes || [];
    } else if (authScheme.type === 'oauth2' && authScheme.flows) {
      const flows = authScheme.flows;
      const flow =
        flows.implicit ||
        flows.authorizationCode ||
        flows.clientCredentials ||
        flows.password;

      if (flow) {
        if ('authorizationUrl' in flow && flow.authorizationUrl) {
          authorizationEndpoint = flow.authorizationUrl;
        } else if ('tokenUrl' in flow && flow.tokenUrl) {
          authorizationEndpoint = flow.tokenUrl;
        }

        if (flow.scopes) {
          scopes = Object.keys(flow.scopes);
        }
      }
    }

    if (!authorizationEndpoint) {
      throw new Error('Authorization endpoint not configured in auth scheme.');
    }

    const state = randomUUID();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('client_id', authCredential.oauth2.clientId || '');
    url.searchParams.set(
      'redirect_uri',
      authCredential.oauth2.redirectUri || '',
    );
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    const exchangedAuthCredential: AuthCredential = {
      ...authCredential,
      oauth2: {
        ...authCredential.oauth2,
        authUri: url.toString(),
        state,
      },
    };

    return exchangedAuthCredential;
  }
}
