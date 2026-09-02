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
  it.each(SENSITIVE_NAMES)('redacts %s', (name) => {
    expect(redactHeaders({[name]: 'secret-value'})).toEqual({
      [name]: REDACTED_HEADER_VALUE,
    });
  });

  it.each(SENSITIVE_NAMES)('redacts %s regardless of case', (name) => {
    const upperCased = name.toUpperCase();
    expect(redactHeaders({[upperCased]: 'secret-value'})).toEqual({
      [upperCased]: REDACTED_HEADER_VALUE,
    });
  });

  it('passes a non-sensitive header through verbatim', () => {
    expect(
      redactHeaders({'content-type': 'application/json', 'accept': 'text/*'}),
    ).toEqual({'content-type': 'application/json', 'accept': 'text/*'});
  });

  it('keeps the non-sensitive headers of a mixed set', () => {
    expect(
      redactHeaders({authorization: 'Bearer abc', 'x-request-id': 'r-1'}),
    ).toEqual({
      authorization: REDACTED_HEADER_VALUE,
      'x-request-id': 'r-1',
    });
  });

  it('does not mutate the input', () => {
    const headers = {authorization: 'Bearer abc'};
    redactHeaders(headers);
    expect(headers).toEqual({authorization: 'Bearer abc'});
  });

  it('returns an empty object for no headers', () => {
    expect(redactHeaders({})).toEqual({});
  });
});
