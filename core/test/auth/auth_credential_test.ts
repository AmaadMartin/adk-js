/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  createOAuth2Auth,
  createServiceAccount,
  OAuth2Auth,
  redactAuthCredential,
  REDACTED,
  ServiceAccountCredential,
  toHttpCredentials,
  validateServiceAccount,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SERVICE_ACCOUNT_CREDENTIAL: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'test_project',
  privateKeyId: 'secret_private_key_id',
  privateKey:
    '-----BEGIN PRIVATE KEY-----\nsecret_key_data\n-----END PRIVATE KEY-----',
  clientEmail: 'test@iam.gserviceaccount.com',
  clientId: '12345',
  authUri: 'https://example.com/o/oauth2/auth',
  tokenUri: 'https://example.com/token',
  authProviderX509CertUrl: 'https://example.com/oauth2/v1/certs',
  clientX509CertUrl: 'https://example.com/robot/v1/metadata/x509/test',
  universeDomain: 'example.com',
};

const MISSING_CREDENTIAL_MESSAGE =
  'serviceAccountCredential is required when useDefaultCredential is false.';

const MISSING_AUDIENCE_MESSAGE =
  "audience is required when useIdToken is true. Set it to the URL of the target service (e.g. 'https://my-service.run.app').";

/** Narrows a value read out of the redacted output to a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('createOAuth2Auth', () => {
  it('defaults tokenEndpointAuthMethod to client_secret_basic', () => {
    expect(createOAuth2Auth({clientId: 'id'}).tokenEndpointAuthMethod).toBe(
      'client_secret_basic',
    );
  });

  it('defaults tokenEndpointAuthMethod when called with no argument', () => {
    expect(createOAuth2Auth().tokenEndpointAuthMethod).toBe(
      'client_secret_basic',
    );
  });

  it('keeps an explicitly supplied tokenEndpointAuthMethod', () => {
    const oauth2 = createOAuth2Auth({
      clientId: 'id',
      tokenEndpointAuthMethod: 'client_secret_post',
    });

    expect(oauth2.tokenEndpointAuthMethod).toBe('client_secret_post');
  });

  it('passes prompt and codeChallengeMethod through without mutating init', () => {
    const init = {
      clientId: 'id',
      prompt: 'login',
      codeChallengeMethod: 'S256',
    };

    const oauth2 = createOAuth2Auth(init);

    expect(oauth2).toEqual({
      clientId: 'id',
      prompt: 'login',
      codeChallengeMethod: 'S256',
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    expect(init).toEqual({
      clientId: 'id',
      prompt: 'login',
      codeChallengeMethod: 'S256',
    });
  });
});

describe('validateServiceAccount', () => {
  it('throws when no credential is set and useDefaultCredential is absent', () => {
    expect(() => validateServiceAccount({})).toThrowError(
      MISSING_CREDENTIAL_MESSAGE,
    );
  });

  it('throws when no credential is set and useDefaultCredential is false', () => {
    expect(() =>
      validateServiceAccount({useDefaultCredential: false}),
    ).toThrowError(MISSING_CREDENTIAL_MESSAGE);
  });

  it('accepts useDefaultCredential without a credential', () => {
    expect(() =>
      validateServiceAccount({useDefaultCredential: true}),
    ).not.toThrow();
  });

  it('throws when useIdToken is set and audience is absent', () => {
    expect(() =>
      validateServiceAccount({
        useIdToken: true,
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      }),
    ).toThrowError(MISSING_AUDIENCE_MESSAGE);
  });

  it('throws when useIdToken is set and audience is empty', () => {
    expect(() =>
      validateServiceAccount({
        useIdToken: true,
        audience: '',
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      }),
    ).toThrowError(MISSING_AUDIENCE_MESSAGE);
  });

  it('accepts useIdToken with an audience', () => {
    expect(() =>
      validateServiceAccount({
        useIdToken: true,
        audience: 'https://svc.run.app',
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      }),
    ).not.toThrow();
  });

  it('does not echo the private key when it rejects a configuration', () => {
    let message = '';
    try {
      validateServiceAccount({
        useIdToken: true,
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(MISSING_AUDIENCE_MESSAGE);
    expect(message).not.toContain('secret_key_data');
  });
});

describe('createServiceAccount', () => {
  it('returns the validated configuration', () => {
    const init = {
      serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    };

    expect(createServiceAccount(init)).toEqual(init);
  });

  it('throws when the credential is missing', () => {
    expect(() => createServiceAccount({})).toThrowError(
      MISSING_CREDENTIAL_MESSAGE,
    );
  });

  it('throws when the audience is missing', () => {
    expect(() =>
      createServiceAccount({
        useIdToken: true,
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      }),
    ).toThrowError(MISSING_AUDIENCE_MESSAGE);
  });
});

describe('toHttpCredentials', () => {
  it('keeps the modelled fields and drops every other key', () => {
    expect(
      toHttpCredentials({
        username: 'user',
        password: 'pw',
        token: 'tok',
        tenant_id: 'xyz',
      }),
    ).toEqual({username: 'user', password: 'pw', token: 'tok'});
  });

  it('omits a field that is absent, undefined or null', () => {
    const credentials = toHttpCredentials({
      password: undefined,
      token: null,
    });

    expect(credentials).toEqual({});
    expect('username' in credentials).toBe(false);
    expect('password' in credentials).toBe(false);
    expect('token' in credentials).toBe(false);
  });

  it('throws when a modelled field is not a string', () => {
    expect(() => toHttpCredentials({password: 42})).toThrowError(
      "Invalid HTTP credentials: 'password' must be a string, got number.",
    );
  });

  it.each([
    ['a string', 'x'],
    ['a number', 42],
    ['null', null],
    ['an array', []],
  ])('throws when data is %s', (_label, data) => {
    expect(() => toHttpCredentials(data)).toThrowError(
      'Invalid HTTP credentials: expected an object.',
    );
  });

  it('does not echo the rejected value in the error message', () => {
    let message = '';
    try {
      toHttpCredentials({password: ['secret_password_999']});
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('password');
    expect(message).not.toContain('secret_password_999');
  });
});

describe('redactAuthCredential', () => {
  it('omits the API key and leaves the original readable', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'sk-live-secret-api-key-12345',
      resourceRef: 'projects/1234/locations/us-central1/resources/resource1',
    };

    const dumped = JSON.stringify(redactAuthCredential(credential));

    expect(dumped).not.toContain('sk-live-secret-api-key-12345');
    expect(dumped).toContain(
      'projects/1234/locations/us-central1/resources/resource1',
    );
    expect(credential.apiKey).toBe('sk-live-secret-api-key-12345');
  });

  it('omits the HTTP password, token and additional headers', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'basic',
        credentials: {
          username: 'my_user',
          password: 'secret_password_999',
          token: 'secret_token_abc',
        },
        additionalHeaders: {Authorization: 'Bearer secret_bearer_token'},
      },
    };

    const dumped = JSON.stringify(redactAuthCredential(credential));

    expect(dumped).not.toContain('secret_password_999');
    expect(dumped).not.toContain('secret_token_abc');
    expect(dumped).not.toContain('secret_bearer_token');
    expect(dumped).toContain('my_user');
    expect(dumped).toContain('basic');
  });

  it('omits every OAuth2 secret and keeps the client id', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'my_client_id',
        clientSecret: 'top_secret_client_secret',
        accessToken: 'secret_access_token',
        refreshToken: 'secret_refresh_token',
        idToken: 'secret_id_token',
        authCode: 'secret_auth_code',
        authResponseUri:
          'https://example.com/callback?code=secret_response_code',
        codeVerifier: 'secret_code_verifier',
      },
    };

    const dumped = JSON.stringify(redactAuthCredential(credential));

    expect(dumped).not.toContain('top_secret_client_secret');
    expect(dumped).not.toContain('secret_access_token');
    expect(dumped).not.toContain('secret_refresh_token');
    expect(dumped).not.toContain('secret_id_token');
    expect(dumped).not.toContain('secret_auth_code');
    expect(dumped).not.toContain('secret_response_code');
    expect(dumped).not.toContain('secret_code_verifier');
    expect(dumped).toContain('my_client_id');
  });

  it('omits the service account private key and its id', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        useIdToken: true,
        audience: 'https://svc.run.app',
      },
    };

    const dumped = JSON.stringify(redactAuthCredential(credential));

    expect(dumped).not.toContain('secret_key_data');
    expect(dumped).not.toContain('secret_private_key_id');
    expect(dumped).toContain('test_project');
    expect(dumped).toContain('test@iam.gserviceaccount.com');
    expect(dumped).toContain('https://svc.run.app');
  });

  it('redacts the value of an extra top-level key but keeps the key', () => {
    const credential: AuthCredential & {undeclaredSecret: string} = {
      authType: AuthCredentialTypes.API_KEY,
      undeclaredSecret: 'secret_extra_value',
    };

    const redacted = redactAuthCredential(credential);
    const dumped = JSON.stringify(redacted);

    expect(dumped).not.toContain('secret_extra_value');
    expect(redacted['undeclaredSecret']).toBe(REDACTED);
    expect(credential.undeclaredSecret).toBe('secret_extra_value');
  });

  it('redacts the value of an extra key on a nested object', () => {
    const oauth2: OAuth2Auth & {unexpectedToken: string} = {
      clientId: 'my_client_id',
      unexpectedToken: 'secret_unexpected_token',
    };
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2,
    };

    const redacted = redactAuthCredential(credential);
    const dumped = JSON.stringify(redacted);

    expect(dumped).not.toContain('secret_unexpected_token');
    expect(dumped).toContain('my_client_id');
    const redactedOauth2 = redacted['oauth2'];
    if (!isPlainObject(redactedOauth2)) {
      expect.fail('expected the redacted oauth2 object to survive');
    }
    expect(redactedOauth2['unexpectedToken']).toBe(REDACTED);
    expect(redactedOauth2['clientId']).toBe('my_client_id');
  });

  it('renders a nested value that is not an object as redacted', () => {
    // A credential rehydrated from session state carries no type guarantee, so
    // a nested slot can hold a string that the walker must not iterate.
    const credential: AuthCredential = JSON.parse(
      '{"authType":"oauth2","oauth2":"secret_oauth2_blob"}',
    );

    const redacted = redactAuthCredential(credential);

    expect(redacted['oauth2']).toBe(REDACTED);
  });

  it('omits a key whose value is undefined', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      resourceRef: undefined,
      http: undefined,
    };

    const redacted = redactAuthCredential(credential);

    expect('resourceRef' in redacted).toBe(false);
    expect('http' in redacted).toBe(false);
  });

  it('drops a declared secret key instead of rendering it redacted', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      apiKey: 'sk-live-secret-api-key-12345',
      http: {
        scheme: 'basic',
        credentials: {
          username: 'my_user',
          password: 'secret_password_999',
          token: 'secret_token_abc',
        },
        additionalHeaders: {Authorization: 'Bearer secret_bearer_token'},
      },
    };

    const redacted = redactAuthCredential(credential);
    const http = redacted['http'];
    if (!isPlainObject(http)) {
      expect.fail('expected the redacted http object to survive');
    }
    const httpCredentials = http['credentials'];
    if (!isPlainObject(httpCredentials)) {
      expect.fail('expected the redacted http credentials to survive');
    }

    expect('apiKey' in redacted).toBe(false);
    expect('additionalHeaders' in http).toBe(false);
    expect('password' in httpCredentials).toBe(false);
    expect('token' in httpCredentials).toBe(false);
    expect(httpCredentials['username']).toBe('my_user');
  });

  it('drops the OAuth2 and service account secret keys', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'my_client_id',
        clientSecret: 'top_secret_client_secret',
        accessToken: 'secret_access_token',
        refreshToken: 'secret_refresh_token',
        idToken: 'secret_id_token',
        authCode: 'secret_auth_code',
        authResponseUri: 'https://example.com/callback?code=x',
        codeVerifier: 'secret_code_verifier',
      },
      serviceAccount: {
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      },
    };

    const redacted = redactAuthCredential(credential);
    const oauth2 = redacted['oauth2'];
    const serviceAccount = redacted['serviceAccount'];
    if (!isPlainObject(oauth2) || !isPlainObject(serviceAccount)) {
      expect.fail('expected the redacted nested objects to survive');
    }
    const saCredential = serviceAccount['serviceAccountCredential'];
    if (!isPlainObject(saCredential)) {
      expect.fail(
        'expected the redacted service account credential to survive',
      );
    }

    for (const key of [
      'clientSecret',
      'accessToken',
      'refreshToken',
      'idToken',
      'authCode',
      'authResponseUri',
      'codeVerifier',
    ]) {
      expect(key in oauth2).toBe(false);
    }
    expect('privateKey' in saCredential).toBe(false);
    expect('privateKeyId' in saCredential).toBe(false);
    expect(saCredential['projectId']).toBe('test_project');
  });

  it('does not modify the credential it is given', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      apiKey: 'sk-live-secret-api-key-12345',
      oauth2: {
        clientId: 'my_client_id',
        clientSecret: 'top_secret_client_secret',
      },
    };
    const before = structuredClone(credential);

    redactAuthCredential(credential);

    expect(credential).toEqual(before);
  });
});
