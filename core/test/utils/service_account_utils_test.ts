/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {parseServiceAccountJson} from '../../src/utils/service_account_utils.js';

const KEY_FILE = {
  'type': 'service_account',
  'project_id': 'dummy',
  'private_key_id': 'dummy',
  'private_key': 'dummy-key',
  'client_email': 'test@example.com',
  'client_id': '131331543646416',
  'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
  'token_uri': 'https://oauth2.googleapis.com/token',
  'auth_provider_x509_cert_url': 'https://www.googleapis.com/oauth2/v1/certs',
  'client_x509_cert_url':
    'http://www.googleapis.com/robot/v1/metadata/x509/dummy%40dummy.com',
  'universe_domain': 'googleapis.com',
};

describe('parseServiceAccountJson', () => {
  it('converts the key file snake_case fields to camelCase', () => {
    const credential = parseServiceAccountJson(JSON.stringify(KEY_FILE));

    expect(credential.clientEmail).toBe('test@example.com');
    expect(credential.privateKey).toBe('dummy-key');
    expect(credential.projectId).toBe('dummy');
    expect(credential.authProviderX509CertUrl).toBe(
      'https://www.googleapis.com/oauth2/v1/certs',
    );
    expect(credential.clientX509CertUrl).toBe(
      'http://www.googleapis.com/robot/v1/metadata/x509/dummy%40dummy.com',
    );
    expect(credential.universeDomain).toBe('googleapis.com');
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseServiceAccountJson('not json')).toThrow(
      /Service account JSON is not valid JSON/,
    );
  });

  it('rejects JSON that is not an object', () => {
    expect(() => parseServiceAccountJson('"a string"')).toThrow(
      /must be an object/,
    );
  });

  it('rejects a key file with no client_email', () => {
    const {client_email: _omitted, ...rest} = KEY_FILE;

    expect(() => parseServiceAccountJson(JSON.stringify(rest))).toThrow(
      /must be an object/,
    );
  });

  it('rejects a key file with an empty private_key', () => {
    const file = {...KEY_FILE, 'private_key': ''};

    expect(() => parseServiceAccountJson(JSON.stringify(file))).toThrow(
      /must be an object/,
    );
  });
});
