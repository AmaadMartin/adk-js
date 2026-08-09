/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthProviderRegistry,
  AuthScheme,
  BaseAuthProvider,
  GcpAuthProviderScheme,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {getTokenEndpoint} from '../../src/auth/oauth2/oauth2_utils.js';

class MockAuthProvider implements BaseAuthProvider {
  async getAuthCredential() {
    return undefined;
  }
}

/** Reads the auth provider resource name through the discriminant. */
function readAuthProviderName(scheme: AuthScheme): string | undefined {
  if (scheme.type === 'gcpAuthProviderScheme') {
    return scheme.name;
  }
  return undefined;
}

const GCP_SCHEME: AuthScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/p/locations/l/authProviders/ap-1',
  scopes: ['https://www.googleapis.com/auth/bigquery'],
  continueUri: 'https://example.com/continue',
};

describe('GcpAuthProviderScheme in the AuthScheme union', () => {
  it('narrows out of AuthScheme on its discriminant', () => {
    expect(readAuthProviderName(GCP_SCHEME)).toBe(
      'projects/p/locations/l/authProviders/ap-1',
    );
  });

  it('leaves other scheme types unnarrowed', () => {
    const apiKeyScheme: AuthScheme = {
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
    };

    expect(readAuthProviderName(apiKeyScheme)).toBeUndefined();
  });

  it('keeps the OAuth2 discriminant narrowing in getTokenEndpoint', () => {
    const oauth2Scheme: AuthScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };

    expect(getTokenEndpoint(oauth2Scheme)).toBe('https://example.com/token');
  });

  it('is not mistaken for an OAuth2 scheme', () => {
    expect(getTokenEndpoint(GCP_SCHEME)).toBeUndefined();
  });

  it('dispatches through AuthProviderRegistry on its type', () => {
    const registry = new AuthProviderRegistry();
    const provider = new MockAuthProvider();
    registry.register('gcpAuthProviderScheme', provider);

    expect(registry.getProvider(GCP_SCHEME)).toBe(provider);
  });

  it('treats scopes and continueUri as optional', () => {
    const minimalScheme: GcpAuthProviderScheme = {
      type: 'gcpAuthProviderScheme',
      name: 'projects/p/locations/l/authProviders/ap-2',
    };

    expect(minimalScheme.scopes).toBeUndefined();
    expect(minimalScheme.continueUri).toBeUndefined();
  });
});
