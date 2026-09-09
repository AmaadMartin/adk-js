/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../../agents/context.js';
import {AuthCredential} from '../../../auth/auth_credential.js';
import {OAuthGrantType} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {determineGrantType} from '../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../utils/experimental.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

class ToolContextCredentialStore {
  constructor(private readonly context: Context) {}

  /**
   * Names the session-state slot a credential is cached in.
   *
   * `credentialKey` namespaces the slot, so two tools sharing a scheme type
   * but authenticating against different servers do not read each other's
   * token. A caller that supplies none keeps the scheme-type slot.
   */
  getCredentialKey(
    authScheme?: OpenAPIV3.SecuritySchemeObject,
    credentialKey?: string,
  ): string {
    const namespace = credentialKey ?? authScheme?.type ?? 'default';
    return `${namespace}_existing_exchanged_credential`;
  }

  getCredential(
    authScheme?: OpenAPIV3.SecuritySchemeObject,
    credentialKey?: string,
  ): AuthCredential | undefined {
    const key = this.getCredentialKey(authScheme, credentialKey);
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

/**
 * Decides whether the end user must authorize before `credential` is usable.
 *
 * An OAuth2 or OpenID Connect credential that holds only a client id and
 * secret cannot be exchanged: every grant except client credentials needs the
 * user to authorize first and hand back an authorization code. Sending such a
 * credential to the exchanger fails, so the client is asked for consent
 * instead.
 *
 * @param authScheme The scheme the tool authenticates with.
 * @param credential The best credential available so far.
 * @return True when the client must collect an authorization from the user.
 */
function needsUserConsent(
  authScheme: OpenAPIV3.SecuritySchemeObject,
  credential: AuthCredential,
): boolean {
  if (authScheme.type !== 'oauth2' && authScheme.type !== 'openIdConnect') {
    return false;
  }
  const {accessToken, authCode, authResponseUri} = credential.oauth2 ?? {};
  if (accessToken || authCode || authResponseUri) {
    return false;
  }
  return determineGrantType(authScheme) !== OAuthGrantType.CLIENT_CREDENTIALS;
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
    const existingCredential = store.getCredential(
      this.authScheme,
      this.credentialKey,
    );

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
    // `pending` forever.
    const authResponseCredential = this.context.getAuthResponse(authConfig);
    const credential = authResponseCredential ?? this.authCredential;

    if (!credential || needsUserConsent(this.authScheme, credential)) {
      // Nothing usable yet, so ask the client to collect a credential.
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
      const key = store.getCredentialKey(this.authScheme, this.credentialKey);
      store.storeCredential(key, result.credential);
    }

    return {state: 'done', authCredential: result.credential};
  }
}
