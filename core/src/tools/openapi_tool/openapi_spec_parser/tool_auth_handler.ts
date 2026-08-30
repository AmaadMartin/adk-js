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
import {
  AuthCredentialMissingError,
  ExchangeResult,
} from '../../../auth/exchanger/base_credential_exchanger.js';
import {determineGrantType} from '../../../auth/oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from '../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../utils/experimental.js';
import {stableDigest} from '../../../utils/hash_utils.js';
import {logger} from '../../../utils/logger.js';
import {AutoAuthCredentialExchanger} from '../auth/credential_exchangers/auto_auth_credential_exchanger.js';

/** What `ToolAuthHandler.prepareAuthCredentials` resolved to. */
export interface AuthPreparationResult {
  state: 'pending' | 'done';
  authCredential?: AuthCredential;
}

/** Credential types that carry an `oauth2` block. */
const OAUTH_CREDENTIAL_TYPES: ReadonlySet<AuthCredentialTypes> = new Set([
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
]);

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
function credentialIdentity(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): string {
  const schemeName = `${authScheme.type}_${stableDigest(authScheme)}`;
  const credentialName = authCredential
    ? `${authCredential.authType}_${stableDigest(
        withoutRoundTripOAuth2Fields(authCredential),
      )}`
    : '';
  return `${schemeName}_${credentialName}`;
}

/**
 * Reports whether `credential` needs the client to supply a new one before the
 * tool can authenticate with it.
 *
 * An OAuth2 or OpenID Connect credential holding no access token has to come
 * back through a consent round trip. The `client_credentials` grant is the
 * exception, and a deliberate divergence from adk-python: adk-js's
 * `OAuth2CredentialExchanger` fetches that token itself, machine to machine,
 * so routing it to the client would build a consent URL out of the token
 * endpoint and strand the tool in `pending` for a user who has nothing to
 * approve.
 */
function requiresClientRoundTrip(
  authScheme: AuthScheme,
  credential: AuthCredential,
): boolean {
  if (!OAUTH_CREDENTIAL_TYPES.has(credential.authType)) {
    return false;
  }
  if (credential.oauth2?.accessToken) {
    return false;
  }
  return determineGrantType(authScheme) !== OAuthGrantType.CLIENT_CREDENTIALS;
}

/**
 * Throws when the credential an OAuth2 consent round trip needs is absent or
 * incomplete. The authorization server rejects the round trip without a client
 * id and secret, so the tool cannot recover from either being missing.
 *
 * This runs only on the path that asks the client to authorize, never against
 * a credential the tool can already use. An OAuth2 scheme is routinely paired
 * with a `serviceAccount` credential, which carries no `oauth2` block and
 * needs no consent: `ServiceAccountCredentialExchanger` mints its bearer
 * token. Validating at entry instead would fail every such tool call.
 */
function assertConsentCredentialComplete(
  authScheme: AuthScheme,
  authCredential?: AuthCredential,
): void {
  if (authScheme.type !== 'oauth2' && authScheme.type !== 'openIdConnect') {
    return;
  }
  const oauth2 = authCredential?.oauth2;
  if (!oauth2) {
    throw new Error(
      `authCredential is empty for scheme ${authScheme.type}. ` +
        'Please create an AuthCredential with an oauth2 field.',
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

/**
 * Returns `stored` with a fresh access token when its own has expired, and
 * writes the refreshed credential back to the session state.
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
  context: Context,
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

  // State.set so the credential lands in the state delta and is persisted. A
  // plain assignment sets an own property on the State instance that is never
  // committed, so the refresh would repeat on every tool invocation.
  context.state.set(cacheKey, refreshed);
  return refreshed;
}

@experimental
export class ToolAuthHandler {
  private readonly credentialKey?: string;

  constructor(
    private readonly context: Context,
    private readonly authScheme?: AuthScheme,
    private readonly authCredential?: AuthCredential,
    options: {credentialKey?: string} = {},
  ) {
    this.credentialKey = options.credentialKey || undefined;
  }

  @experimental
  public static fromToolContext(
    context: Context,
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
    options: {credentialKey?: string} = {},
  ): ToolAuthHandler {
    return new ToolAuthHandler(context, authScheme, authCredential, options);
  }

  @experimental
  public async prepareAuthCredentials(): Promise<AuthPreparationResult> {
    const authScheme = this.authScheme;
    if (!authScheme) {
      return {state: 'done'};
    }

    const identity = credentialIdentity(authScheme, this.authCredential);
    const cacheKey =
      this.credentialKey ?? `${identity}_existing_exchanged_credential`;

    const cached = await this.cachedCredential(authScheme, cacheKey);
    if (cached && !requiresClientRoundTrip(authScheme, cached)) {
      return {state: 'done', authCredential: cached};
    }

    const authConfig: AuthConfig = {
      authScheme,
      rawAuthCredential: this.authCredential,
      // The auth response lands in `temp:<credentialKey>`, so a key shared by
      // every OpenAPI tool lets one tool consume another tool's response.
      credentialKey: this.credentialKey ?? `adk_${identity}`,
    };

    // A credential the tool was configured with is used as it stands, unless
    // it still needs a token only the client can obtain. Schemes such as
    // `apiKey`, `http` and `serviceAccount` never need one, so requesting a
    // credential for them would strand the tool in `pending` forever.
    const configured = this.authCredential;
    const usable =
      configured && !requiresClientRoundTrip(authScheme, configured);
    const credential = usable
      ? configured
      : this.context.getAuthResponse(authConfig);

    if (!credential) {
      assertConsentCredentialComplete(authScheme, this.authCredential);
      this.context.requestCredential(authConfig);

      return {state: 'pending'};
    }

    const exchange = await this.exchange(authScheme, credential);
    if (!exchange) {
      return {state: 'done'};
    }

    // Only cache what cannot cheaply be obtained again: an auth response is
    // readable once, and an exchange costs a round trip. A statically
    // configured credential that needed no exchange is already available on
    // every invocation, so persisting it to session state would only copy a
    // secret into the session store for nothing.
    if (!usable || exchange.wasExchanged) {
      // State.set so the credential is recorded in the state delta and
      // persisted. A plain assignment would be dropped, re-running the
      // exchange on every tool invocation.
      this.context.state.set(cacheKey, exchange.credential);
    }

    return {state: 'done', authCredential: exchange.credential};
  }

  private async cachedCredential(
    authScheme: AuthScheme,
    cacheKey: string,
  ): Promise<AuthCredential | undefined> {
    // Read through the State API to see values persisted by previous tool
    // calls. `context.state` is a `State` instance, not a plain object, so
    // bracket access would bypass its value store and always miss.
    const stored = this.context.state.get<AuthCredential>(cacheKey);
    if (!stored) {
      return undefined;
    }
    return refreshIfExpired(this.context, cacheKey, authScheme, stored);
  }

  /**
   * Exchanges `credential`, resolving `undefined` when the exchange fails.
   *
   * A provider that refuses the exchange leaves the tool with no credential,
   * not with a broken invocation: `RestApiTool` then calls the API without one
   * and surfaces whatever the API answers. The exchange error reaches the
   * operator through `logger.error`, because nothing reads a failure carried
   * on the result.
   */
  private async exchange(
    authScheme: AuthScheme,
    credential: AuthCredential,
  ): Promise<ExchangeResult | undefined> {
    try {
      return await new AutoAuthCredentialExchanger().exchange({
        authScheme,
        authCredential: credential,
      });
    } catch (e: unknown) {
      logger.error('Failed to exchange credential:', e);
      return undefined;
    }
  }
}
