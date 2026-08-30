/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {redactHeaders} from '../../src/utils/redact_headers.js';

describe('redactHeaders', () => {
  it('redacts every sensitive header', () => {
    const redacted = redactHeaders({
      'api-key': 'k',
      'authorization': 'Bearer t',
      'cookie': 'a=b',
      'proxy-authorization': 'Basic x',
      'set-cookie': 'c=d',
      'x-api-key': 'k2',
      'x-goog-api-key': 'k3',
    });

    expect(redacted).toEqual({
      'api-key': '<redacted>',
      'authorization': '<redacted>',
      'cookie': '<redacted>',
      'proxy-authorization': '<redacted>',
      'set-cookie': '<redacted>',
      'x-api-key': '<redacted>',
      'x-goog-api-key': '<redacted>',
    });
  });

  it('matches a sensitive header regardless of case', () => {
    expect(
      redactHeaders({'Authorization': 'Bearer t', 'X-API-Key': 'k'}),
    ).toEqual({'Authorization': '<redacted>', 'X-API-Key': '<redacted>'});
  });

  it('passes a non-sensitive header through verbatim', () => {
    expect(
      redactHeaders({'content-type': 'application/json', 'accept': '*/*'}),
    ).toEqual({'content-type': 'application/json', 'accept': '*/*'});
  });

  it('does not mutate the input', () => {
    const headers = {authorization: 'Bearer t'};

    redactHeaders(headers);

    expect(headers).toEqual({authorization: 'Bearer t'});
  });

  it('returns an empty object for empty headers', () => {
    expect(redactHeaders({})).toEqual({});
  });
});
