/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  isCredentialLike,
  isSensitiveKey,
  REDACTED,
  redactPrivateKeyBlocks,
  safeSerialize,
  safeSerializeRecord,
} from '../../src/utils/redact_secrets.js';

const SENTINEL_ACCESS_TOKEN = 'sentinel-access-token-4f7a21';
const SENTINEL_CLIENT_SECRET = 'sentinel-client-secret-b58d6e';
const SENTINEL_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nsentinel-key-body\n-----END PRIVATE KEY-----';

/**
 * Number of wrappers that puts the innermost value one level past the walk
 * bound, where it is labelled rather than serialized.
 */
const WALK_BOUND_DEPTH = 21;

function oauthCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'test-client-id',
      clientSecret: SENTINEL_CLIENT_SECRET,
      accessToken: SENTINEL_ACCESS_TOKEN,
    },
  };
}

describe('isCredentialLike', () => {
  it('detects an AuthCredential by its authType', () => {
    expect(isCredentialLike(oauthCredential())).toBe(true);
    for (const authType of Object.values(AuthCredentialTypes)) {
      expect(isCredentialLike({authType})).toBe(true);
    }
  });

  it('rejects an authType that names no credential type', () => {
    expect(isCredentialLike({authType: 'not-a-real-type'})).toBe(false);
    expect(isCredentialLike({authType: 7})).toBe(false);
  });

  it('detects a ServiceAccountCredential by its literal type field', () => {
    expect(isCredentialLike({type: 'service_account', privateKey: 'x'})).toBe(
      true,
    );
  });

  it('rejects another object carrying an unrelated type field', () => {
    expect(isCredentialLike({type: 'user_account'})).toBe(false);
  });

  it('detects a ServiceAccount by its nested credential', () => {
    expect(isCredentialLike({serviceAccountCredential: {}})).toBe(true);
  });

  it('detects a ServiceAccount by scopes plus a credential switch', () => {
    expect(isCredentialLike({scopes: [], useDefaultCredential: true})).toBe(
      true,
    );
    expect(isCredentialLike({scopes: [], useIdToken: false})).toBe(true);
  });

  it('rejects a bare scopes list, which any tool argument may carry', () => {
    expect(isCredentialLike({scopes: ['read']})).toBe(false);
  });

  it('detects an HttpAuth by its scheme and credentials pair', () => {
    expect(
      isCredentialLike({scheme: 'bearer', credentials: {token: 'x'}}),
    ).toBe(true);
  });

  it('rejects a scheme without a credentials object', () => {
    expect(isCredentialLike({scheme: 'bearer'})).toBe(false);
    expect(isCredentialLike({scheme: 'bearer', credentials: 'x'})).toBe(false);
  });

  it('detects an HttpCredentials by two of its three fields', () => {
    expect(isCredentialLike({username: 'u', password: 'p'})).toBe(true);
    expect(isCredentialLike({username: 'u', token: 't'})).toBe(true);
  });

  it('rejects a single-field object, which its key name redacts instead', () => {
    expect(isCredentialLike({token: 't'})).toBe(false);
    expect(isCredentialLike({username: 'u', role: 'admin'})).toBe(false);
  });

  it('detects an OAuth2Auth by a secret-bearing field', () => {
    for (const key of [
      'clientSecret',
      'accessToken',
      'refreshToken',
      'idToken',
      'authCode',
      'codeVerifier',
      'authResponseUri',
    ]) {
      expect(isCredentialLike({[key]: 'x'})).toBe(true);
    }
  });

  it('rejects an OAuth2Auth that carries only a client id', () => {
    // Divergence from adk-python: `isinstance` would catch a bare
    // `OAuth2Auth(client_id=...)`, but it holds nothing to protect.
    expect(isCredentialLike({clientId: 'x'})).toBe(false);
  });

  it('rejects an ordinary object that happens to carry a token', () => {
    expect(isCredentialLike({accessToken: 'x', rows: 3})).toBe(false);
  });

  it('keeps the siblings of a token in an ordinary object', () => {
    // Collapsing the whole object would drop `rows` from the trace. The key
    // name redacts the token on its own.
    expect(
      safeSerializeRecord({accessToken: SENTINEL_ACCESS_TOKEN, rows: 3}),
    ).toEqual({accessToken: REDACTED, rows: 3});
  });

  it('rejects values that are not objects', () => {
    expect(isCredentialLike(null)).toBe(false);
    expect(isCredentialLike(undefined)).toBe(false);
    expect(isCredentialLike('accessToken')).toBe(false);
    expect(isCredentialLike(7)).toBe(false);
    expect(isCredentialLike([{accessToken: 'x'}])).toBe(false);
  });
});

describe('isSensitiveKey', () => {
  it('redacts every temp-scoped state key, credential or not', () => {
    expect(isSensitiveKey('temp:oauth2_credential')).toBe(true);
    expect(isSensitiveKey('temp:intermediate_result')).toBe(true);
  });

  it('strips the app and user state scopes before matching', () => {
    expect(isSensitiveKey('user:api_key')).toBe(true);
    expect(isSensitiveKey('app:client_secret')).toBe(true);
    expect(isSensitiveKey('user:profile')).toBe(false);
  });

  it('folds hyphenated header spellings', () => {
    expect(isSensitiveKey('X-Api-Key')).toBe(true);
    expect(isSensitiveKey('Proxy-Authorization')).toBe(true);
    expect(isSensitiveKey('Content-Type')).toBe(false);
  });

  it('folds camel case', () => {
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('serviceAccountCredentials')).toBe(true);
    expect(isSensitiveKey('displayName')).toBe(false);
  });

  it('matches a compound name by substring', () => {
    expect(isSensitiveKey('openai_api_key')).toBe(true);
    expect(isSensitiveKey('secret_key')).toBe(true);
    expect(isSensitiveKey('my_passwd_field')).toBe(true);
  });

  it('matches a token name by suffix, not by substring', () => {
    expect(isSensitiveKey('bearer_token')).toBe(true);
    expect(isSensitiveKey('promptTokenCount')).toBe(false);
    expect(isSensitiveKey('max_output_tokens')).toBe(false);
  });

  it('keeps an unrelated key', () => {
    expect(isSensitiveKey('cache_key')).toBe(false);
    expect(isSensitiveKey('counter')).toBe(false);
  });
});

describe('redactPrivateKeyBlocks', () => {
  it('cuts only the block out of a longer string', () => {
    expect(
      redactPrivateKeyBlocks(`here is my key ${SENTINEL_PRIVATE_KEY} thanks`),
    ).toBe(`here is my key ${REDACTED} thanks`);
  });

  it('redacts a block whose footer never arrives', () => {
    expect(
      redactPrivateKeyBlocks(
        '-----BEGIN PRIVATE KEY-----\nsentinel-key-body\n',
      ),
    ).toBe(REDACTED);
  });

  it('keeps prose that quotes armor fragments', () => {
    const prose = 'notes about a PRIVATE KEY----- and -----BEGIN elsewhere';
    expect(redactPrivateKeyBlocks(prose)).toBe(prose);
  });

  it('redacts every block in one string', () => {
    const two = `${SENTINEL_PRIVATE_KEY} and ${SENTINEL_PRIVATE_KEY}`;
    expect(redactPrivateKeyBlocks(two)).toBe(`${REDACTED} and ${REDACTED}`);
  });
});

describe('safeSerialize', () => {
  it('maps null and undefined to null', () => {
    expect(safeSerialize(null)).toBeNull();
    expect(safeSerialize(undefined)).toBeNull();
  });

  it('passes scalars through', () => {
    expect(safeSerialize('plain')).toBe('plain');
    expect(safeSerialize(7)).toBe(7);
    expect(safeSerialize(true)).toBe(true);
  });

  it('renders a bigint as a string, which YAML has no type for', () => {
    expect(safeSerialize(90071992547409919n)).toBe('90071992547409919');
  });

  it('renders a date as an ISO-8601 string', () => {
    expect(safeSerialize(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('reports the size of a binary value without its bytes', () => {
    expect(safeSerialize(new TextEncoder().encode('binary data'))).toBe(
      '<bytes: 11 bytes>',
    );
    expect(safeSerialize(Buffer.from('binary data'))).toBe('<bytes: 11 bytes>');
  });

  it('renders a set as an array', () => {
    expect(safeSerialize(new Set(['a', 1]))).toEqual(['a', 1]);
  });

  it('walks a map like an object, redacting by key name', () => {
    const map = new Map<unknown, unknown>([
      ['accessToken', SENTINEL_ACCESS_TOKEN],
      ['label', 'keep-me'],
      [7, 'numeric key'],
    ]);

    expect(safeSerialize(map)).toEqual({
      accessToken: REDACTED,
      label: 'keep-me',
      '7': 'numeric key',
    });
  });

  it('renders a function and a symbol as strings', () => {
    expect(safeSerialize(Symbol('sig'))).toBe('Symbol(sig)');
    expect(typeof safeSerialize(() => 1)).toBe('string');
  });

  it('renders a class instance through its own toString', () => {
    class Marker {
      toString(): string {
        return 'marker-instance';
      }
    }

    expect(safeSerialize(new Marker())).toBe('marker-instance');
  });

  it('reports a value whose toString throws as unserializable', () => {
    const hostile = {
      toString(): string {
        throw new Error('no string for you');
      },
    };

    // A plain object is walked field by field, so the throwing `toString`
    // is only reached once the value is not a mapping.
    expect(safeSerialize(Object.assign(Object.create({}), hostile))).toBe(
      '<unserializable>',
    );
  });

  it('redacts a credential nested at several depths and inside arrays', () => {
    const result = safeSerialize({
      someUsersOwnKey: [
        {inner: [oauthCredential(), 'keep-me']},
        {label: 'deep', payload: oauthCredential()},
        {a: {b: {c: {d: oauthCredential()}}}},
      ],
    });

    expect(result).toEqual({
      someUsersOwnKey: [
        {inner: [REDACTED, 'keep-me']},
        {label: 'deep', payload: REDACTED},
        {a: {b: {c: {d: REDACTED}}}},
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ACCESS_TOKEN);
  });

  it('redacts a credential that sits deeper than the walk bound', () => {
    let deep: unknown = oauthCredential();
    for (let i = 0; i < 60; i++) {
      deep = {level: deep};
    }

    expect(JSON.stringify(safeSerialize(deep))).not.toContain(
      SENTINEL_ACCESS_TOKEN,
    );
  });

  it('labels the value type when the walk bound is reached', () => {
    let deepObject: unknown = {leaf: 'value'};
    let deepArray: unknown = ['leaf'];
    for (let i = 0; i < 30; i++) {
      deepObject = {level: deepObject};
      deepArray = [deepArray];
    }

    expect(JSON.stringify(safeSerialize(deepObject))).toContain('<Object ...>');
    expect(JSON.stringify(safeSerialize(deepArray))).toContain('<Array ...>');
  });

  it('labels a prototype-less value at the bound as an object', () => {
    // A value with no prototype has no constructor to take a name from.
    // `WALK_BOUND_DEPTH` wrappers put it exactly at the bound.
    let deepBare: unknown = Object.assign(Object.create(null), {leaf: 'v'});
    for (let i = 0; i < WALK_BOUND_DEPTH; i++) {
      deepBare = {level: deepBare};
    }

    expect(JSON.stringify(safeSerialize(deepBare))).toContain('<Object ...>');
  });

  it('terminates on a self-referential value', () => {
    const cyclic: Record<string, unknown> = {credential: oauthCredential()};
    cyclic['itself'] = cyclic;

    const result = safeSerialize(cyclic);

    expect((result as Record<string, unknown>)['credential']).toBe(REDACTED);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_ACCESS_TOKEN);
  });
});

describe('safeSerializeRecord', () => {
  it('redacts by key name and walks the rest', () => {
    expect(
      safeSerializeRecord({
        'api_key': SENTINEL_CLIENT_SECRET,
        'notes': ['harmless', SENTINEL_PRIVATE_KEY],
      }),
    ).toEqual({
      'api_key': REDACTED,
      'notes': ['harmless', REDACTED],
    });
  });
});
