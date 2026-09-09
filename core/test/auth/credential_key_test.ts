/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  OAuth2Auth,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  credentialIdentity,
  credentialKeyOverride,
  deriveCredentialKey,
} from '../../src/auth/credential_key.js';

const OIDC_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://provider.example.com/.well-known/openid-config',
  authorizationEndpoint: 'https://provider.example.com/authorize',
  tokenEndpoint: 'https://provider.example.com/token',
};

/** OAuth2 fields a consent round trip fills in, or a deployment changes. */
const VOLATILE_FIELDS: ReadonlyArray<[keyof OAuth2Auth, string | number]> = [
  ['authUri', 'https://provider.example.com/authorize?state=abc'],
  ['state', 'state-value'],
  ['authResponseUri', 'https://app.example.com/callback?code=abc'],
  ['authCode', 'auth-code'],
  ['accessToken', 'access-token'],
  ['refreshToken', 'refresh-token'],
  ['expiresAt', 1234567890],
  ['expiresIn', 3600],
  ['redirectUri', 'https://app.example.com/callback'],
];

function oauth2Credential(oauth2: OAuth2Auth): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

/**
 * Attaches fields the type does not declare, as a scheme or a credential read
 * from a configuration document carries them.
 */
function withExtra<T extends object>(
  source: T,
  extra: Record<string, unknown>,
): T {
  return Object.assign({}, source, extra);
}

const BASE_CREDENTIAL = oauth2Credential({
  clientId: 'client-id',
  clientSecret: 'client-secret',
});

describe('credentialIdentity', () => {
  it('names the scheme type and the credential type', async () => {
    const identity = await credentialIdentity(OIDC_SCHEME, BASE_CREDENTIAL);

    expect(identity).toMatch(
      /^openIdConnect_[0-9a-f]{16}_oauth2_[0-9a-f]{16}$/,
    );
  });

  it('is empty on both sides when there is neither', async () => {
    expect(await credentialIdentity()).toBe('_');
  });

  it('omits the credential half when there is no credential', async () => {
    const identity = await credentialIdentity(OIDC_SCHEME);

    expect(identity).toMatch(/^openIdConnect_[0-9a-f]{16}_$/);
  });

  it.each(VOLATILE_FIELDS)(
    'ignores the volatile oauth2 field %s',
    async (field, value) => {
      const withField = oauth2Credential({
        ...BASE_CREDENTIAL.oauth2,
        [field]: value,
      });

      expect(await credentialIdentity(OIDC_SCHEME, withField)).toBe(
        await credentialIdentity(OIDC_SCHEME, BASE_CREDENTIAL),
      );
    },
  );

  it('changes when the clientId changes', async () => {
    const other = oauth2Credential({
      ...BASE_CREDENTIAL.oauth2,
      clientId: 'other-client-id',
    });

    expect(await credentialIdentity(OIDC_SCHEME, other)).not.toBe(
      await credentialIdentity(OIDC_SCHEME, BASE_CREDENTIAL),
    );
  });

  it('changes when the scheme changes', async () => {
    const other: AuthScheme = {
      ...OIDC_SCHEME,
      tokenEndpoint: 'https://other.example.com/token',
    };

    expect(await credentialIdentity(other, BASE_CREDENTIAL)).not.toBe(
      await credentialIdentity(OIDC_SCHEME, BASE_CREDENTIAL),
    );
  });

  it('is unchanged by a credentialKey extra field on either object', async () => {
    const expected = await credentialIdentity(OIDC_SCHEME, BASE_CREDENTIAL);

    expect(
      await credentialIdentity(
        withExtra(OIDC_SCHEME, {credentialKey: 'named'}),
        withExtra(BASE_CREDENTIAL, {credential_key: 'named'}),
      ),
    ).toBe(expected);
  });

  it('survives a token refresh', async () => {
    const before = oauth2Credential({
      ...BASE_CREDENTIAL.oauth2,
      accessToken: 'first-token',
      refreshToken: 'first-refresh',
      expiresAt: 1000,
    });
    const after = oauth2Credential({
      ...BASE_CREDENTIAL.oauth2,
      accessToken: 'second-token',
      refreshToken: 'second-refresh',
      expiresAt: 2000,
    });

    expect(await credentialIdentity(OIDC_SCHEME, before)).toBe(
      await credentialIdentity(OIDC_SCHEME, after),
    );
  });
});

describe('deriveCredentialKey', () => {
  it('prefixes the identity with adk_', async () => {
    expect(await deriveCredentialKey(OIDC_SCHEME, BASE_CREDENTIAL)).toBe(
      `adk_${await credentialIdentity(OIDC_SCHEME, BASE_CREDENTIAL)}`,
    );
  });
});

describe('credentialKeyOverride', () => {
  it('returns undefined when nobody named a key', () => {
    expect(
      credentialKeyOverride(undefined, OIDC_SCHEME, BASE_CREDENTIAL),
    ).toBeUndefined();
  });

  it('returns the explicit key', () => {
    expect(credentialKeyOverride('explicit')).toBe('explicit');
  });

  it('reads credential_key from the credential', () => {
    expect(
      credentialKeyOverride(
        undefined,
        OIDC_SCHEME,
        withExtra(BASE_CREDENTIAL, {credential_key: 'from-credential'}),
      ),
    ).toBe('from-credential');
  });

  it('reads credentialKey from the credential', () => {
    expect(
      credentialKeyOverride(
        undefined,
        OIDC_SCHEME,
        withExtra(BASE_CREDENTIAL, {credentialKey: 'from-credential'}),
      ),
    ).toBe('from-credential');
  });

  it('reads the key from the scheme', () => {
    expect(
      credentialKeyOverride(
        undefined,
        withExtra(OIDC_SCHEME, {credential_key: 'from-scheme'}),
        BASE_CREDENTIAL,
      ),
    ).toBe('from-scheme');
  });

  it('prefers the credential over the scheme', () => {
    expect(
      credentialKeyOverride(
        undefined,
        withExtra(OIDC_SCHEME, {credential_key: 'from-scheme'}),
        withExtra(BASE_CREDENTIAL, {credential_key: 'from-credential'}),
      ),
    ).toBe('from-credential');
  });

  it('prefers the explicit key over both', () => {
    expect(
      credentialKeyOverride(
        'explicit',
        withExtra(OIDC_SCHEME, {credential_key: 'from-scheme'}),
        withExtra(BASE_CREDENTIAL, {credential_key: 'from-credential'}),
      ),
    ).toBe('explicit');
  });

  it('ignores a key that is not a non-empty string', () => {
    expect(
      credentialKeyOverride(
        undefined,
        OIDC_SCHEME,
        withExtra(BASE_CREDENTIAL, {credential_key: '', credentialKey: 42}),
      ),
    ).toBeUndefined();
  });
});
