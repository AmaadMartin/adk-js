/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {parseServiceAccountCredential} from '../../src/utils/service_account_utils.js';

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

describe('parseServiceAccountCredential', () => {
  it('converts every snake_case field to its camelCase name', () => {
    expect(parseServiceAccountCredential(keyFile())).toEqual({
      type: 'service_account',
      projectId: 'test-project',
      privateKeyId: 'test-key-id',
      privateKey: PRIVATE_KEY,
      clientEmail: 'test@example.com',
      clientId: 'test-client-id',
      authUri: 'https://accounts.google.com/o/oauth2/auth',
      tokenUri: 'https://oauth2.googleapis.com/token',
      authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
      clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/sa',
      universeDomain: 'googleapis.com',
    });
  });

  it('drops the fields the credential does not declare', () => {
    const withExtra = JSON.stringify({
      ...KEY_FIELDS,
      unexpected_field: 'ignored',
    });

    expect(parseServiceAccountCredential(withExtra)).not.toHaveProperty(
      'unexpectedField',
    );
  });

  it.each([
    ['type', 'type'],
    ['private_key', 'privateKey'],
    ['client_email', 'clientEmail'],
  ])('rejects a key with no %s', (omitted, reported) => {
    expect(() => parseServiceAccountCredential(keyFile(omitted))).toThrow(
      new InputValidationError(
        `Service account key is missing the required field "${reported}".`,
      ),
    );
  });

  it('rejects a field that is present but empty', () => {
    const empty = JSON.stringify({...KEY_FIELDS, client_email: ''});

    expect(() => parseServiceAccountCredential(empty)).toThrow(
      'Service account key is missing the required field "clientEmail".',
    );
  });

  it('rejects a field that is not a string', () => {
    const wrongType = JSON.stringify({...KEY_FIELDS, private_key: 42});

    expect(() => parseServiceAccountCredential(wrongType)).toThrow(
      'Service account key is missing the required field "privateKey".',
    );
  });

  it('accepts a key that omits the fields the exchange never reads', () => {
    const trimmed = keyFile(
      'project_id',
      'private_key_id',
      'client_id',
      'auth_uri',
      'token_uri',
      'auth_provider_x509_cert_url',
      'client_x509_cert_url',
      'universe_domain',
    );

    expect(parseServiceAccountCredential(trimmed)).toEqual({
      type: 'service_account',
      projectId: '',
      privateKeyId: '',
      privateKey: PRIVATE_KEY,
      clientEmail: 'test@example.com',
      clientId: '',
      authUri: '',
      tokenUri: '',
      authProviderX509CertUrl: '',
      clientX509CertUrl: '',
      universeDomain: '',
    });
  });

  it('rejects a key naming another credential type', () => {
    const authorizedUser = JSON.stringify({
      ...KEY_FIELDS,
      type: 'authorized_user',
    });

    expect(() => parseServiceAccountCredential(authorizedUser)).toThrow(
      new InputValidationError(
        'Service account key must name the type "service_account".',
      ),
    );
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseServiceAccountCredential('{not json')).toThrow(
      new InputValidationError('Service account key is not valid JSON.'),
    );
  });

  it('rejects JSON that is not an object', () => {
    expect(() => parseServiceAccountCredential('[1, 2]')).toThrow(
      new InputValidationError('Service account key must be a JSON object.'),
    );
  });

  it('keeps the private key out of the error of a truncated file', () => {
    const truncated = JSON.stringify(KEY_FIELDS).slice(0, -3);

    expect(() => parseServiceAccountCredential(truncated)).toThrow(
      /^Service account key is not valid JSON\.$/,
    );
  });
});
