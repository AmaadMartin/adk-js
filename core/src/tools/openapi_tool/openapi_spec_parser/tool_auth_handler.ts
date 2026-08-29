/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../auth/auth_credential.js';
import {OAuthGrantType} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {determineGrantType} from '../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../utils/experimental.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

const OAUTH_CREDENTIAL_TYPES: readonly AuthCredentialTypes[] = [
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
];

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

/**
 * Reports whether the user must authorize a credential before it can be
 * exchanged for a token.
 *
 * The authorization code grant needs the user to consent in a browser, so a
 * credential carrying only a client id and secret is not exchangeable yet. An
 * api key, a service account and the client credentials grant need no
 * interaction, and neither does a credential that already holds the user's
 * token, code or authorization response.
 *
 * @param authScheme The scheme the tool authenticates with.
 * @param credential The credential the tool was configured with.
 * @return True when the user has still to authorize the credential.
 */
function needsUserAuthorization(
  authScheme: OpenAPIV3.SecuritySchemeObject,
  credential?: AuthCredential,
): boolean {
  if (!credential || !OAUTH_CREDENTIAL_TYPES.includes(credential.authType)) {
    return false;
  }
  if (determineGrantType(authScheme) !== OAuthGrantType.AUTHORIZATION_CODE) {
    return false;
  }

  const {accessToken, authCode, authResponseUri} = credential.oauth2 ?? {};
  return !accessToken && !authCode && !authResponseUri;
}

class ToolContextCredentialStore {
  constructor(private readonly context: Context) {}

  getCredentialKey(authScheme?: OpenAPIV3.SecuritySchemeObject): string {
    const schemeName = authScheme?.type || 'default';
    return `${schemeName}_existing_exchanged_credential`;
  }

  getCredential(
    authScheme?: OpenAPIV3.SecuritySchemeObject,
  ): AuthCredential | undefined {
    const key = this.getCredentialKey(authScheme);
    // Read through the State API so we see values persisted from previous
    // tool calls. `context.state` is a `State` instance, not a plain object;
    // bracket access would bypass its value/delta store and always miss.
    return this.context.state.get<AuthCredential>(key);
  }

  storeCredential(key: string, credential: AuthCredential) {
    // Use State.set so the credential is recorded in the state delta and
    // persisted to the session. A plain assignment (`state[key] = ...`) sets
    // an own property on the State instance that is never committed, so the
    // exchanged credential would be re-created on every tool invocation.
    this.context.state.set(key, credential);
  }
}

@experimental
export class ToolAuthHandler {
  constructor(
    private readonly context: Context,
    private readonly authScheme?: OpenAPIV3.SecuritySchemeObject,
    private readonly authCredential?: AuthCredential,
    private readonly credentialKey?: string,
  ) {}

  @experimental
  public static fromToolContext(
    context: Context,
    authScheme?: OpenAPIV3.SecuritySchemeObject,
    authCredential?: AuthCredential,
    options: {credentialKey?: string} = {},
  ): ToolAuthHandler {
    return new ToolAuthHandler(
      context,
      authScheme,
      authCredential,
      options.credentialKey,
    );
  }

  @experimental
  public async prepareAuthCredentials(): Promise<AuthPreparationResult> {
    if (!this.authScheme) {
      return {state: 'done'};
    }

    const store = new ToolContextCredentialStore(this.context);
    const existingCredential = store.getCredential(this.authScheme);

    if (existingCredential) {
      return {state: 'done', authCredential: existingCredential};
    }

    const authConfig: AuthConfig = {
      authScheme: this.authScheme,
      rawAuthCredential: this.authCredential,
      credentialKey: this.credentialKey || 'default_openapi_key',
    };

    // A credential returned by an auth response was supplied interactively by
    // the client. Otherwise fall back to the credential the tool was
    // configured with, as long as it can be exchanged without the user:
    // schemes such as `apiKey`, `http` and `serviceAccount` need no
    // interaction, so requesting one would strand the tool in `pending`
    // forever.
    const authResponseCredential = this.context.getAuthResponse(authConfig);
    const configuredCredential = needsUserAuthorization(
      this.authScheme,
      this.authCredential,
    )
      ? undefined
      : this.authCredential;
    const credential = authResponseCredential ?? configuredCredential;

    if (!credential) {
      // No credential to work with, so ask the client for one.
      this.context.requestCredential(authConfig);

      return {state: 'pending'};
    }

    const exchanger = new AutoAuthCredentialExchanger();
    const result = await exchanger.exchange({
      authScheme: this.authScheme,
      authCredential: credential,
    });

    // Only cache what cannot cheaply be obtained again: an auth response is
    // readable once, and an exchange costs a round trip. A statically
    // configured credential that needed no exchange is already available on
    // every invocation, so persisting it to session state would only copy a
    // secret into the session store for nothing.
    if (authResponseCredential || result.wasExchanged) {
      const key = store.getCredentialKey(this.authScheme);
      store.storeCredential(key, result.credential);
    }

    return {state: 'done', authCredential: result.credential};
  }
}
