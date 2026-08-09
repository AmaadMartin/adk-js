/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../../agents/context.js';
import {AuthCredential, OAuth2Auth} from '../../../auth/auth_credential.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {experimental} from '../../../utils/experimental.js';
import {stableDigest} from '../../../utils/hash_utils.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

/**
 * OAuth2 fields that a consent round trip produces, or that change per
 * deployment. They say nothing about which credential this is, so they must
 * not contribute to its cache identity. The tokens are deliberately absent
 * from this list: an `accessToken` or `refreshToken` the tool was configured
 * with is the credential, so two tools holding different tokens must not
 * share a slot.
 */
const ROUND_TRIP_OAUTH2_FIELDS: readonly (keyof OAuth2Auth)[] = [
  'authUri',
  'state',
  'authResponseUri',
  'authCode',
  'codeVerifier',
  'nonce',
  'expiresAt',
  'expiresIn',
  'redirectUri',
];

function withoutRoundTripOAuth2Fields(
  credential: AuthCredential,
): AuthCredential {
  if (!credential.oauth2) {
    return credential;
  }

  const oauth2 = {...credential.oauth2};
  for (const field of ROUND_TRIP_OAUTH2_FIELDS) {
    delete oauth2[field];
  }
  return {...credential, oauth2};
}

class ToolContextCredentialStore {
  constructor(private readonly context: Context) {}

  async getCredentialKey(
    authScheme: OpenAPIV3.SecuritySchemeObject,
    authCredential?: AuthCredential,
  ): Promise<string> {
    // The digest identifies the scheme and the credential, so two tools that
    // declare the same scheme type against different APIs get their own slot
    // instead of serving each other the first exchanged token.
    const schemeName = `${authScheme.type}_${await stableDigest(authScheme)}`;
    const credentialName = authCredential
      ? `${authCredential.authType}_${await stableDigest(
          withoutRoundTripOAuth2Fields(authCredential),
        )}`
      : '';
    return `${schemeName}_${credentialName}_existing_exchanged_credential`;
  }

  async getCredential(
    authScheme: OpenAPIV3.SecuritySchemeObject,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    const key = await this.getCredentialKey(authScheme, authCredential);
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
    const existingCredential = await store.getCredential(
      this.authScheme,
      this.authCredential,
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
      const key = await store.getCredentialKey(
        this.authScheme,
        this.authCredential,
      );
      store.storeCredential(key, result.credential);
    }

    return {state: 'done', authCredential: result.credential};
  }
}
