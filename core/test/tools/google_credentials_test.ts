/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseGoogleCredentialsConfig, InputValidationError} from '@google/adk';
import {OAuth2Client, PassThroughClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const SCOPES = ['https://www.googleapis.com/auth/bigtable.data'];

/** An authorized-user client, which carries an OAuth identity of its own. */
function makeOAuthClient(scope?: string): OAuth2Client {
  const client = new OAuth2Client({
    clientId: 'copied-id',
    clientSecret: 'copied-secret',
  });
  client.setCredentials({access_token: 'token', scope});
  return client;
}

describe('BaseGoogleCredentialsConfig valid combinations', () => {
  it('accepts an existing credential on its own', () => {
    const credentials = new PassThroughClient();

    const config = new BaseGoogleCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.externalAccessTokenKey).toBeUndefined();
  });

  it('accepts an external access token key on its own', () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'access_token',
    });

    expect(config.externalAccessTokenKey).toBe('access_token');
    expect(config.credentials).toBeUndefined();
  });

  it('accepts a client id and secret pair', () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: SCOPES,
    });

    expect(config.clientId).toBe('client-id');
    expect(config.clientSecret).toBe('client-secret');
    expect(config.scopes).toEqual(SCOPES);
  });

  it('accepts an existing credential with an empty scopes list', () => {
    // adk-python tests these fields for falsiness, so an empty list reads as
    // "no scopes named" rather than as a conflicting scopes option.
    const config = new BaseGoogleCredentialsConfig({
      credentials: new PassThroughClient(),
      scopes: [],
    });

    expect(config.scopes).toEqual([]);
  });

  it('leaves the scopes and the token cache key to a subclass', () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'access_token',
    });

    expect(config.scopes).toBeUndefined();
    expect(config.tokenCacheKey).toBeUndefined();
  });
});

describe('BaseGoogleCredentialsConfig identity adoption', () => {
  it('adopts nothing from a client that carries no OAuth identity', () => {
    // PassThroughClient extends AuthClient directly, so it never assigns
    // `_clientId` — the shape a service account or metadata credential has.
    const config = new BaseGoogleCredentialsConfig({
      credentials: new PassThroughClient(),
    });

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });

  it('adopts the identity and granted scopes of an authorized-user client', () => {
    // The auth library stores the granted scope as one space-delimited
    // string, where adk-python holds a list.
    const config = new BaseGoogleCredentialsConfig({
      credentials: makeOAuthClient('scope-a scope-b'),
    });

    expect(config.clientId).toBe('copied-id');
    expect(config.clientSecret).toBe('copied-secret');
    expect(config.scopes).toEqual(['scope-a', 'scope-b']);
  });

  it('adopts an identity that granted no scope', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: makeOAuthClient(),
    });

    expect(config.clientId).toBe('copied-id');
    expect(config.scopes).toBeUndefined();
  });

  it('adopts an identity that carries only a client secret', () => {
    const client = new OAuth2Client({clientSecret: 'secret-only'});

    const config = new BaseGoogleCredentialsConfig({credentials: client});

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBe('secret-only');
  });
});

describe('BaseGoogleCredentialsConfig validation', () => {
  const credentialsMessage =
    'If credentials are provided, externalAccessTokenKey, clientId, ' +
    'clientSecret, and scopes must not be provided.';
  const externalKeyMessage =
    'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
    'scopes must not be provided.';
  const missingSourceMessage =
    'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
    'and clientSecret pair.';

  it('rejects credentials combined with an external access token key', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: new PassThroughClient(),
          externalAccessTokenKey: 'access_token',
        }),
    ).toThrow(new InputValidationError(credentialsMessage));
  });

  it('rejects credentials combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: new PassThroughClient(),
          clientId: 'client-id',
        }),
    ).toThrow(new InputValidationError(credentialsMessage));
  });

  it('rejects credentials combined with a client secret', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: new PassThroughClient(),
          clientSecret: 'client-secret',
        }),
    ).toThrow(new InputValidationError(credentialsMessage));
  });

  it('rejects credentials combined with scopes', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: new PassThroughClient(),
          scopes: SCOPES,
        }),
    ).toThrow(new InputValidationError(credentialsMessage));
  });

  it('rejects an external access token key combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'access_token',
          clientId: 'client-id',
        }),
    ).toThrow(new InputValidationError(externalKeyMessage));
  });

  it('rejects an external access token key combined with scopes', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'access_token',
          scopes: SCOPES,
        }),
    ).toThrow(new InputValidationError(externalKeyMessage));
  });

  it('rejects an empty configuration', () => {
    expect(() => new BaseGoogleCredentialsConfig({})).toThrow(
      new InputValidationError(missingSourceMessage),
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(
      () => new BaseGoogleCredentialsConfig({clientId: 'client-id'}),
    ).toThrow(new InputValidationError(missingSourceMessage));
  });

  it('rejects a client secret without a client id', () => {
    expect(
      () => new BaseGoogleCredentialsConfig({clientSecret: 'client-secret'}),
    ).toThrow(new InputValidationError(missingSourceMessage));
  });

  it('throws InputValidationError, not a bare Error', () => {
    expect(() => new BaseGoogleCredentialsConfig({})).toThrow(
      InputValidationError,
    );
  });
});
