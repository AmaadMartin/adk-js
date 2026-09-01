/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  REDACTED_HEADER_VALUE,
  redactHeaders,
} from '../../src/utils/redact_headers.js';

const SENSITIVE_NAMES = [
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
];

describe('redactHeaders', () => {
  for (const name of SENSITIVE_NAMES) {
    it(`masks ${name}`, () => {
      expect(redactHeaders({[name]: 'secret'})).toEqual({
        [name]: REDACTED_HEADER_VALUE,
      });
    });
  }

  it('matches a header name case-insensitively', () => {
    expect(
      redactHeaders({'Authorization': 'Bearer t', 'X-API-Key': 'k'}),
    ).toEqual({
      'Authorization': REDACTED_HEADER_VALUE,
      'X-API-Key': REDACTED_HEADER_VALUE,
    });
  });

  it('passes an ordinary header through', () => {
    expect(redactHeaders({'content-type': 'application/json'})).toEqual({
      'content-type': 'application/json',
    });
  });

  it('does not mutate its input', () => {
    const headers = {authorization: 'Bearer token'};

    redactHeaders(headers);

    expect(headers).toEqual({authorization: 'Bearer token'});
  });

  it('returns an empty object for empty headers', () => {
    expect(redactHeaders({})).toEqual({});
  });
});
