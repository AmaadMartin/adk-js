/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../auth/auth_credential.js';
import {AuthScheme, OAuthGrantType} from '../../../auth/auth_schemes.js';
import {AuthConfig} from '../../../auth/auth_tool.js';
import {
  credentialIdentity,
  credentialKeyOverride,
  deriveCredentialKey,
} from '../../../auth/credential_key.js';
import {
  AuthCredentialMissingError,
  BaseCredentialExchanger,
} from '../../../auth/exchanger/base_credential_exchanger.js';
import {determineGrantType} from '../../../auth/oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from '../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../utils/experimental.js';
import {logger} from '../../../utils/logger.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

/** What {@link ToolAuthHandler.prepareAuthCredentials} resolved to. */
export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

/**
 * Reads and writes the credential a tool has already obtained.
 *
 * This is a structural interface, so any object of this shape can be injected:
 * an in-memory store in a test, or a store backed by a secret manager.
 */
export interface CredentialStore {
  /** Returns the stored credential for this pair, if there is one. */
  getCredential(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined>;

  /** Stores `credential` as the credential this pair resolved to. */
  storeCredential(
    credential: AuthCredential,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<void>;
}

/** Options for {@link ToolAuthHandler}. */
export interface ToolAuthHandlerOptions {
  /** Names the key the credential is stored and requested under. */
  credentialKey?: string;
  /** Exchanges the credential. Defaults to an exchanger picked by type. */
  credentialExchanger?: BaseCredentialExchanger;
  /** Holds the credential between tool calls. Defaults to the session state. */
  credentialStore?: CredentialStore;
}

/** Suffix of the session state key holding a tool's credential. */
const STORE_KEY_SUFFIX = '_existing_exchanged_credential';

function isOAuthScheme(authScheme: AuthScheme): boolean {
  return authScheme.type === 'oauth2' || authScheme.type === 'openIdConnect';
}

/**
 * Reports whether the client has to supply a credential before the tool can
 * authenticate.
 *
 * An OAuth2 or OpenID Connect credential holding no access token needs a
 * consent round trip. The `client_credentials` grant is the exception, and a
 * deliberate divergence from adk-python: adk-js exchanges that grant itself,
 * machine to machine, so routing it to the client would strand the tool in
 * `pending` for a user who has nothing to approve.
 */
function externalExchangeRequired(
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
 * Throws when the credential a consent round trip needs is absent or
 * incomplete. The authorization server rejects the round trip without a client
 * id and a client secret, so the tool cannot recover from either being
 * missing.
 */
function assertConsentCredentialComplete(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): void {
  if (!isOAuthScheme(authScheme)) {
    return;
  }
  const oauth2 = authCredential?.oauth2;
  if (!oauth2) {
    throw new Error(
      `auth credential is empty for scheme ${authScheme.type}. Create an ` +
        'AuthCredential with an oauth2 field.',
    );
  }
  if (!oauth2.clientId) {
    throw new AuthCredentialMissingError(
      'OAuth2 credentials clientId is missing.',
    );
  }
  if (!oauth2.clientSecret) {
    throw new AuthCredentialMissingError(
      'OAuth2 credentials clientSecret is missing.',
    );
  }
}

/** Holds a tool's credential in the session state. */
export class ToolContextCredentialStore implements CredentialStore {
  constructor(private readonly context: Context) {}

  async getCredentialKey(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<string> {
    const identity = await credentialIdentity(authScheme, authCredential);
    return `${identity}${STORE_KEY_SUFFIX}`;
  }

  /**
   * Returns the key earlier releases stored the credential under, which was
   * derived from the scheme type alone.
   */
  getLegacyCredentialKey(authScheme?: AuthScheme): string {
    return `${authScheme?.type ?? 'default'}${STORE_KEY_SUFFIX}`;
  }

  async getCredential(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    const key = await this.getCredentialKey(authScheme, authCredential);
    // Read through the State API so we see values persisted from previous
    // tool calls. `context.state` is a `State` instance, not a plain object;
    // bracket access would bypass its value/delta store and always miss.
    const stored = this.context.state.get<AuthCredential>(key);
    if (stored) {
      return stored;
    }

    // The two formats never collide: a derived key always carries a scheme
    // digest and a credential digest, and the legacy key has neither.
    const legacyKey = this.getLegacyCredentialKey(authScheme);
    const legacy = this.context.state.get<AuthCredential>(legacyKey);
    if (!legacy) {
      return undefined;
    }

    // Copy the credential to the current key rather than moving it, so that a
    // rollback to an earlier release still finds it.
    logger.debug('Migrating a tool credential from the legacy key.');
    this.context.state.set(key, legacy);
    return legacy;
  }

  async storeCredential(
    credential: AuthCredential,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<void> {
    // Use State.set so the credential is recorded in the state delta and
    // persisted to the session. A plain assignment (`state[key] = ...`) sets
    // an own property on the State instance that is never committed, so the
    // exchanged credential would be re-created on every tool invocation.
    this.context.state.set(
      await this.getCredentialKey(authScheme, authCredential),
      credential,
    );
  }
}

@experimental
export class ToolAuthHandler {
  private readonly credentialExchanger: BaseCredentialExchanger;
  private readonly credentialStore: CredentialStore;
  private readonly credentialKey?: string;

  constructor(
    private readonly context: Context,
    private readonly authScheme?: AuthScheme,
    private readonly authCredential?: AuthCredential,
    options: ToolAuthHandlerOptions = {},
  ) {
    this.credentialExchanger =
      options.credentialExchanger ?? new AutoAuthCredentialExchanger();
    this.credentialStore =
      options.credentialStore ?? new ToolContextCredentialStore(context);
    this.credentialKey = credentialKeyOverride(
      options.credentialKey,
      authScheme,
      authCredential,
    );
  }

  @experimental
  public static fromToolContext(
    context: Context,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
    options: ToolAuthHandlerOptions = {},
  ): ToolAuthHandler {
    return new ToolAuthHandler(context, authScheme, authCredential, options);
  }

  @experimental
  public async prepareAuthCredentials(): Promise<AuthPreparationResult> {
    const authScheme = this.authScheme;
    if (!authScheme) {
      return {state: 'done'};
    }

    const existing = await this.getExistingCredential();
    let credential = existing ?? this.authCredential;
    let fromAuthResponse = false;

    // OAuth2 authorization code and OpenID Connect need a multi-step exchange
    // that only the client can complete: client id and secret, then an
    // authorization code, then an access token.
    if (!credential || externalExchangeRequired(authScheme, credential)) {
      const authConfig = await this.buildAuthConfig(authScheme);
      credential = this.context.getAuthResponse(authConfig);
      if (!credential) {
        assertConsentCredentialComplete(authScheme, this.authCredential);
        this.context.requestCredential(authConfig);
        return {state: 'pending', authCredential: this.authCredential};
      }
      // Store what the client supplied before exchanging it. That is the
      // durable credential: it carries the refresh token a later invocation
      // refreshes with, which the exchanged credential does not.
      fromAuthResponse = true;
      await this.storeCredential(credential);
    }

    const result = await this.credentialExchanger.exchange({
      authScheme,
      authCredential: credential,
    });

    // An exchange costs a round trip, so its result is worth persisting. The
    // auth response path already stored the credential it has to keep.
    if (result.wasExchanged && !fromAuthResponse) {
      await this.storeCredential(result.credential);
    }

    return {state: 'done', authCredential: result.credential};
  }

  private async buildAuthConfig(authScheme: AuthScheme): Promise<AuthConfig> {
    return {
      authScheme,
      rawAuthCredential: this.authCredential,
      // The auth response lands in `temp:<credentialKey>`, so a key shared by
      // every OpenAPI tool would let one tool consume another tool's response.
      credentialKey:
        this.credentialKey ??
        (await deriveCredentialKey(authScheme, this.authCredential)),
    };
  }

  /** Returns the stored credential, refreshed and re-stored when expired. */
  private async getExistingCredential(): Promise<AuthCredential | undefined> {
    const existing = await this.credentialStore.getCredential(
      this.authScheme,
      this.authCredential,
    );
    if (!existing?.oauth2) {
      return existing;
    }

    const refresher = new OAuth2CredentialRefresher();
    if (!(await refresher.isRefreshNeeded(existing))) {
      return existing;
    }

    // Persist the refreshed credential, so a provider that rotates its refresh
    // token on every refresh does not invalidate the stored one.
    const refreshed = await refresher.refresh(existing, this.authScheme);
    await this.storeCredential(refreshed);
    return refreshed;
  }

  private async storeCredential(credential: AuthCredential): Promise<void> {
    await this.credentialStore.storeCredential(
      credential,
      this.authScheme,
      this.authCredential,
    );
  }
}
