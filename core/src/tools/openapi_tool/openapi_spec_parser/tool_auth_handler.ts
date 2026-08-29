/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../../agents/context.js';
import {AuthCredential} from '../../../auth/auth_credential.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {OAuth2CredentialRefresher} from '../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../utils/experimental.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
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
      return {
        state: 'done',
        authCredential: await this.useStoredCredential(
          existingCredential,
          store,
        ),
      };
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

    // An OAuth2 credential that holds an access token is the durable one: it
    // also carries the refresh token and the expiry that a later call needs,
    // while the bearer credential derived from it carries neither.
    const credentialToStore = credential.oauth2?.accessToken
      ? credential
      : result.credential;

    // Only cache what cannot cheaply be obtained again: an auth response is
    // readable once, and an exchange costs a round trip. A statically
    // configured credential that needed no exchange is already available on
    // every invocation, so persisting it to session state would only copy a
    // secret into the session store for nothing.
    if (authResponseCredential || result.wasExchanged) {
      const key = store.getCredentialKey(this.authScheme);
      store.storeCredential(key, credentialToStore);
    }

    return {state: 'done', authCredential: result.credential};
  }

  /**
   * Derives the credential a request can carry from the one a previous tool
   * call stored.
   *
   * An OAuth2 credential is refreshed when its access token has expired, then
   * converted into the bearer credential the Authorization header needs. Any
   * other credential is already in the form the header needs.
   */
  private async useStoredCredential(
    storedCredential: AuthCredential,
    store: ToolContextCredentialStore,
  ): Promise<AuthCredential> {
    if (!storedCredential.oauth2) {
      return storedCredential;
    }

    let credential = storedCredential;
    const refresher = new OAuth2CredentialRefresher();

    if (await refresher.isRefreshNeeded(credential)) {
      credential = await refresher.refresh(credential, this.authScheme);
      // A provider that rotates the refresh token invalidates the previous
      // one, so the refreshed credential replaces the stored one.
      store.storeCredential(
        store.getCredentialKey(this.authScheme),
        credential,
      );
    }

    const result = await new AutoAuthCredentialExchanger().exchange({
      authScheme: this.authScheme,
      authCredential: credential,
    });

    return result.credential;
  }
}
