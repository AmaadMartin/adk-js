/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  PUBSUB_DEFAULT_SCOPE,
  PUBSUB_TOKEN_CACHE_KEY,
  PubSubCredentialsConfig,
} from '@google/adk';
import {Compute} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

describe('PubSubCredentialsConfig constants', () => {
  it('pins the scope adk-python requests', () => {
    expect(PUBSUB_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/pubsub',
    ]);
  });

  it('pins the session-state key adk-python caches under', () => {
    expect(PUBSUB_TOKEN_CACHE_KEY).toBe('pubsub_token_cache');
  });
});

describe('PubSubCredentialsConfig token cache key', () => {
  it('is set in the OAuth2 consent mode', () => {
    const config = new PubSubCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.tokenCacheKey).toBe(PUBSUB_TOKEN_CACHE_KEY);
  });

  it('is set in the pre-built credential mode', () => {
    const config = new PubSubCredentialsConfig({credentials: new Compute()});

    expect(config.tokenCacheKey).toBe(PUBSUB_TOKEN_CACHE_KEY);
  });

  it('is set in the external access token mode', () => {
    const config = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(config.tokenCacheKey).toBe(PUBSUB_TOKEN_CACHE_KEY);
  });
});

describe('PubSubCredentialsConfig default scopes', () => {
  it('keeps scopes the caller named', () => {
    const config = new PubSubCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
  });

  it('applies the default in the external access token mode', () => {
    const config = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(config.scopes).toEqual([...PUBSUB_DEFAULT_SCOPE]);
  });

  it('applies the default to a client carrying no OAuth identity', () => {
    const config = new PubSubCredentialsConfig({credentials: new Compute()});

    expect(config.scopes).toEqual([...PUBSUB_DEFAULT_SCOPE]);
  });

  it('gives two configs two arrays, so neither can mutate the other', () => {
    const first = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });
    const second = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(PUBSUB_DEFAULT_SCOPE);
  });
});

describe('PubSubCredentialsConfig inheritance', () => {
  it('carries the fields of the base config', () => {
    const base: BaseGoogleCredentialsConfig = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(base.externalAccessTokenKey).toBe('my_pubsub_token');
    expect(base.credentials).toBeUndefined();
    expect(base.clientId).toBeUndefined();
    expect(base.clientSecret).toBeUndefined();
  });
});
