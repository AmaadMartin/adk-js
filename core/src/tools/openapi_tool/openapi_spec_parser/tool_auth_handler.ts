/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
  OAuth2Auth,
} from '../../../auth/auth_credential.js';
import {AuthScheme, OAuthGrantType} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {AuthCredentialMissingError} from '../../../auth/exchanger/base_credential_exchanger.js';
import {determineGrantType} from '../../../auth/oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from '../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../utils/experimental.js';
import {stableDigest} from '../../../utils/hash_utils.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

export interface AuthPreparationResult {
  state: 'pending' | 'done';
  /** The scheme the credential authenticates, when the tool declares one. */
  authScheme?: AuthScheme;
  authCredential?: AuthCredential;
}

/** Scheme types whose credential only an end user can grant. */
const USER_AUTHORIZED_SCHEME_TYPES: readonly string[] = [
  'oauth2',
  'openIdConnect',
];

/** Property names a caller can set to name a credential slot themselves. */
const CREDENTIAL_KEY_PROPERTIES: readonly string[] = [
  'credential_key',
  'credentialKey',
];

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

/**
 * Names the credential a tool asks for, as the scheme it authenticates and the
 * credential the tool was configured with. Both the cache slot and the auth
 * request slot are built from this, so a tool always reads back what it wrote.
 */
async function credentialIdentity(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): Promise<string> {
  const schemeName = `${authScheme.type}_${await stableDigest(authScheme)}`;
  const credentialName = authCredential
    ? `${authCredential.authType}_${await stableDigest(
        withoutRoundTripOAuth2Fields(authCredential),
      )}`
    : '';
  return `${schemeName}_${credentialName}`;
}

class ToolContextCredentialStore {
  constructor(
    private readonly context: Context,
    private readonly credentialKeyOverride?: string,
  ) {}

  getCredentialKey(identity: string): string {
    // A key the developer named wins over the derived one: it is how they
    // point several tools at one credential, or keep two apart. It cannot
    // collide with the auth request slot, which lives under `temp:`.
    if (this.credentialKeyOverride) {
      return this.credentialKeyOverride;
    }
    // The digest identifies the scheme and the credential, so two tools that
    // declare the same scheme type against different APIs get their own slot
    // instead of serving each other the first exchanged token.
    return `${identity}_existing_exchanged_credential`;
  }

  getCredential(key: string): AuthCredential | undefined {
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
 * Returns `stored` with a fresh access token when its own has expired, and
 * writes the refreshed credential back to `store`.
 *
 * The write-back is what makes the next invocation work against a provider
 * that rotates the refresh token on every refresh: without it the tool keeps
 * presenting a refresh token the provider has already invalidated.
 * `OAuth2CredentialRefresher` hands back the credential it was given, by
 * reference, on every path that cannot refresh: no OAuth2 tokens, no refresh
 * token, no token endpoint on the scheme, no client id and secret, or a token
 * request that failed. Re-writing that credential would put it in the state
 * delta of every tool call, so the write-back is skipped when the reference
 * has not changed.
 */
async function refreshIfExpired(
  store: ToolContextCredentialStore,
  cacheKey: string,
  authScheme: AuthScheme,
  stored: AuthCredential,
): Promise<AuthCredential> {
  const refresher = new OAuth2CredentialRefresher();
  if (!(await refresher.isRefreshNeeded(stored))) {
    return stored;
  }

  const refreshed = await refresher.refresh(stored, authScheme);
  if (refreshed === stored) {
    return stored;
  }

  store.storeCredential(cacheKey, refreshed);
  return refreshed;
}

/** Reads a slot name a caller set on a credential or on a scheme. */
function readCredentialKeyProperty(source?: object): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const name of CREDENTIAL_KEY_PROPERTIES) {
    if (!(name in source)) {
      continue;
    }
    const value = (source as Record<string, unknown>)[name];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}

/**
 * The slot the caller named, from the constructor option or from a
 * `credential_key` property carried on the credential or on the scheme.
 * Undefined when the caller named none, so the derived slot is used.
 */
function credentialKeyOverride(
  explicitKey: string | undefined,
  authCredential: AuthCredential | undefined,
  authScheme: AuthScheme,
): string | undefined {
  return (
    explicitKey ||
    readCredentialKeyProperty(authCredential) ||
    readCredentialKeyProperty(authScheme)
  );
}

/**
 * True when `credential` cannot authenticate a call until the end user
 * authorizes it.
 *
 * An OAuth2 or OpenID Connect credential holding no access token has to come
 * back from a consent round trip. The exception is the client-credentials
 * grant, which `OAuth2CredentialExchanger` mints from the client id and secret
 * with no user involved: asking the client to authorize one would leave the
 * tool in `pending` forever.
 */
function needsUserAuthorization(
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
  return determineGrantType(authScheme) !== OAuthGrantType.CLIENT_CREDENTIALS;
}

/**
 * Throws when the tool cannot raise an authorization request the client is
 * able to answer. The client builds the authorization URL from the OAuth2
 * client id and secret, so a request raised without them strands the tool.
 */
function validateAuthorizationRequest(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): void {
  if (!USER_AUTHORIZED_SCHEME_TYPES.includes(authScheme.type)) {
    return;
  }
  if (!authCredential?.oauth2) {
    throw new Error(
      `authCredential is empty for scheme ${authScheme.type}. Please create an AuthCredential with an oauth2 block.`,
    );
  }
  if (!authCredential.oauth2.clientId) {
    throw new AuthCredentialMissingError(
      'OAuth2 credentials client_id is missing.',
    );
  }
  if (!authCredential.oauth2.clientSecret) {
    throw new AuthCredentialMissingError(
      'OAuth2 credentials client_secret is missing.',
    );
  }
}

@experimental
export class ToolAuthHandler {
  constructor(
    private readonly context: Context,
    private readonly authScheme?: AuthScheme,
    private readonly authCredential?: AuthCredential,
    private readonly credentialKey?: string,
  ) {}

  @experimental
  public static fromToolContext(
    context: Context,
    authScheme?: AuthScheme,
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

    const identity = await credentialIdentity(
      this.authScheme,
      this.authCredential,
    );
    const keyOverride = credentialKeyOverride(
      this.credentialKey,
      this.authCredential,
      this.authScheme,
    );
    const store = new ToolContextCredentialStore(this.context, keyOverride);
    const cacheKey = store.getCredentialKey(identity);
    const storedCredential = store.getCredential(cacheKey);

    if (storedCredential) {
      const current = await refreshIfExpired(
        store,
        cacheKey,
        this.authScheme,
        storedCredential,
      );
      // A cached credential carries its own token, and every exchanger adk-js
      // registers hands such a credential back unchanged, so the tool gets it
      // as it is. One that carries no token cannot authenticate a call, so
      // the handler asks the client to authorize a new one instead.
      if (!needsUserAuthorization(this.authScheme, current)) {
        return {
          state: 'done',
          authScheme: this.authScheme,
          authCredential: current,
        };
      }
    }

    const authConfig: AuthConfig = {
      authScheme: this.authScheme,
      rawAuthCredential: this.authCredential,
      // The auth response lands in `temp:<credentialKey>`, so a key shared by
      // every OpenAPI tool lets one tool consume another tool's response.
      credentialKey: keyOverride || `adk_${identity}`,
    };

    // A credential returned by an auth response was supplied interactively by
    // the client. Otherwise fall back to the credential the tool was
    // configured with: schemes such as `apiKey`, `http` and `serviceAccount`
    // need no user interaction, so requesting one would strand the tool in
    // `pending` forever.
    const authResponseCredential = this.context.getAuthResponse(authConfig);
    const credential = authResponseCredential ?? this.authCredential;

    if (!credential || needsUserAuthorization(this.authScheme, credential)) {
      validateAuthorizationRequest(this.authScheme, this.authCredential);
      this.context.requestCredential(authConfig);

      return {
        state: 'pending',
        authScheme: this.authScheme,
        authCredential: this.authCredential,
      };
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
      store.storeCredential(cacheKey, result.credential);
    }

    return {
      state: 'done',
      authScheme: this.authScheme,
      authCredential: result.credential,
    };
  }
}
