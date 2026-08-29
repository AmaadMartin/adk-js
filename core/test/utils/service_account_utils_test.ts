/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {parseServiceAccountKey} from '../../src/utils/service_account_utils.js';

/** The private key bytes a malformed key must never copy into an error. */
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nsecretbytes\n';

const KEY_FIELDS: Record<string, string> = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: PRIVATE_KEY,
  client_email: 'test@example.com',
  client_id: 'test-client-id',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/sa',
  universe_domain: 'googleapis.com',
};

/** Serialises a complete key file, minus the named fields. */
function keyFile(...omit: string[]): string {
  const fields = {...KEY_FIELDS};
  for (const field of omit) {
    delete fields[field];
  }
  return JSON.stringify(fields);
}

describe('parseServiceAccountKey', () => {
  it('reads only the two fields the library signs with', () => {
    expect(parseServiceAccountKey(keyFile())).toEqual({
      clientEmail: 'test@example.com',
      privateKey: PRIVATE_KEY,
    });
  });

  it('accepts a key that carries nothing but the signing fields', () => {
    const minimal = JSON.stringify({
      private_key: PRIVATE_KEY,
      client_email: 'test@example.com',
    });

    expect(parseServiceAccountKey(minimal)).toEqual({
      clientEmail: 'test@example.com',
      privateKey: PRIVATE_KEY,
    });
  });

  it.each(['client_email', 'private_key'])(
    'rejects a key with no %s',
    (omitted) => {
      expect(() => parseServiceAccountKey(keyFile(omitted))).toThrow(
        new InputValidationError(
          `Service account key is missing the required field "${omitted}".`,
        ),
      );
    },
  );

  it('rejects a field that is present but empty', () => {
    const empty = JSON.stringify({...KEY_FIELDS, client_email: ''});

    expect(() => parseServiceAccountKey(empty)).toThrow(
      'Service account key is missing the required field "client_email".',
    );
  });

  it('rejects a field that is not a string', () => {
    const wrongType = JSON.stringify({...KEY_FIELDS, private_key: 42});

    expect(() => parseServiceAccountKey(wrongType)).toThrow(
      'Service account key is missing the required field "private_key".',
    );
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseServiceAccountKey('{not json')).toThrow(
      new InputValidationError('Service account key is not valid JSON.'),
    );
  });

  it('rejects JSON that is not an object', () => {
    expect(() => parseServiceAccountKey('[1, 2]')).toThrow(
      new InputValidationError('Service account key must be a JSON object.'),
    );
  });

  it('keeps the private key out of the error of a truncated file', () => {
    const truncated = JSON.stringify(KEY_FIELDS).slice(0, -3);

    expect(() => parseServiceAccountKey(truncated)).toThrow(
      /^Service account key is not valid JSON\.$/,
    );
  });
});
