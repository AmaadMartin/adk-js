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
import {AuthScheme, OAuthGrantType} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {determineGrantType} from '../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../utils/experimental.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

/**
 * Whether a token for `credential` can only be minted once the end user has
 * signed in.
 *
 * The two-legged `clientCredentials` flow authenticates the application
 * itself, so a configured `{clientId, clientSecret}` is all it needs. The
 * `authorizationCode` grant mints a token against a user's consent: until one
 * comes back the configured credential authorizes nothing, and handing it to
 * the exchanger only raises a missing-authorization-code error.
 *
 * Narrows `_external_exchange_required` from adk-python's
 * `tool_auth_handler.py` to the one grant that needs a human and that
 * `OAuth2CredentialExchanger` can finish afterwards. The `implicit` and
 * `password` grants also need a human, but neither the exchanger nor the
 * `response_type=code` URI `AuthHandler` builds can complete them, so asking
 * the user to sign in for those would only replace one dead end with another.
 */
function requiresUserSignIn(
  authScheme: AuthScheme,
  credential: AuthCredential,
): boolean {
  if (
    credential.authType !== AuthCredentialTypes.OAUTH2 &&
    credential.authType !== AuthCredentialTypes.OPEN_ID_CONNECT
  ) {
    return false;
  }

  if (credential.oauth2?.accessToken) {
    return false;
  }

  return determineGrantType(authScheme) === OAuthGrantType.AUTHORIZATION_CODE;
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
    // configured with: schemes such as `apiKey`, `http` and `serviceAccount`
    // need no user interaction, so requesting one would strand the tool in
    // `pending` forever. A user-interactive OAuth2 grant is the exception: its
    // configured client id and secret cannot authorize anything until the user
    // has signed in.
    const authResponseCredential = this.context.getAuthResponse(authConfig);
    const configuredCredential =
      this.authCredential &&
      requiresUserSignIn(this.authScheme, this.authCredential)
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
