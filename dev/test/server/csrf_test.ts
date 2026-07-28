/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {isForbiddenCrossOrigin} from '../../src/server/csrf.js';

const SERVER_HOST = 'localhost:8000';
const FOREIGN_ORIGIN = 'http://example.invalid';
const TRUSTED_ORIGIN = 'http://trusted.example';

describe('isForbiddenCrossOrigin', () => {
  it.each<[string, string | undefined, string | undefined, boolean]>([
    ['no origin, a non-browser client', undefined, SERVER_HOST, false],
    ['an empty origin', '', SERVER_HOST, false],
    ['the same origin', 'http://localhost:8000', SERVER_HOST, false],
    // The comparison is host-only because the Host header carries no scheme.
    [
      'another scheme on the same host',
      'https://localhost:8000',
      SERVER_HOST,
      false,
    ],
    ['another port', 'http://localhost:8000', 'localhost:8001', true],
    ['another host', FOREIGN_ORIGIN, SERVER_HOST, true],
    ['an opaque origin', 'null', SERVER_HOST, true],
    ['an unparsable origin', 'not a url', SERVER_HOST, true],
    ['an unknown host', 'http://localhost:8000', undefined, true],
  ])('resolves %s', (_name, origin, host, forbidden) => {
    expect(isForbiddenCrossOrigin(origin, host)).toBe(forbidden);
  });

  it.each<[string, string, string, boolean]>([
    ['a wildcard', FOREIGN_ORIGIN, '*', false],
    ['the configured origin', TRUSTED_ORIGIN, TRUSTED_ORIGIN, false],
    ['any other origin', FOREIGN_ORIGIN, TRUSTED_ORIGIN, true],
  ])(
    'with allowOrigins, resolves %s',
    (_name, origin, allowOrigins, forbidden) => {
      expect(isForbiddenCrossOrigin(origin, SERVER_HOST, allowOrigins)).toBe(
        forbidden,
      );
    },
  );
});
