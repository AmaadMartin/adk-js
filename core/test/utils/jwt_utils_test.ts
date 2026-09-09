/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {readJwtExpirySeconds} from '../../src/utils/jwt_utils.js';

function base64url(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function tokenWithPayload(payload: string): string {
  return `header.${base64url(payload)}.signature`;
}

describe('readJwtExpirySeconds', () => {
  it('reads the exp claim', () => {
    expect(readJwtExpirySeconds(tokenWithPayload('{"exp":1773268800}'))).toBe(
      1773268800,
    );
  });

  it('reads a payload that uses the base64url alphabet', () => {
    // '~~~?' encodes to 'fn5+Pw', whose base64 form 'fn5-Pw' carries the `-`
    // that distinguishes the two alphabets.
    const payload = JSON.stringify({sub: '~~~?', exp: 1773268800});
    const encoded = base64url(payload);

    expect(encoded).toContain('-');
    expect(readJwtExpirySeconds(`header.${encoded}.signature`)).toBe(
      1773268800,
    );
  });

  it.each([
    ['a token that is not three segments', 'opaque-token'],
    ['a payload that is not JSON', tokenWithPayload('not json')],
    ['a payload that is not an object', tokenWithPayload('123')],
    ['a payload that is null', tokenWithPayload('null')],
    ['a payload with no exp claim', tokenWithPayload('{}')],
    ['a payload whose exp is not a number', tokenWithPayload('{"exp":"soon"}')],
    ['a payload whose exp is infinite', tokenWithPayload('{"exp":1e999}')],
  ])('returns undefined for %s', (_description, token) => {
    expect(readJwtExpirySeconds(token)).toBeUndefined();
  });
});
