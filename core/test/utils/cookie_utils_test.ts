/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {appendCookie} from '../../src/utils/cookie_utils.js';

describe('appendCookie', () => {
  it('writes the first cookie under the canonical Cookie key', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'session_id', 'abc123');

    expect(headers).toEqual({Cookie: 'session_id=abc123'});
  });

  it('joins a second cookie onto the existing header', () => {
    const headers: Record<string, string> = {Cookie: 'session_id=abc'};

    appendCookie(headers, 'tenant', 'acme');

    expect(headers['Cookie']).toBe('session_id=abc; tenant=acme');
  });

  it('reuses a differently spelled cookie header', () => {
    const headers: Record<string, string> = {cookie: 'theme=dark'};

    appendCookie(headers, 'tenant', 'acme');

    expect(headers['cookie']).toBe('theme=dark; tenant=acme');
    expect(headers['Cookie']).toBeUndefined();
  });

  it('percent-encodes the separators a value could use to forge a cookie', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'session_id', 'a b;c=d,e');

    expect(headers['Cookie']).toBe('session_id=a%20b%3Bc%3Dd%2Ce');
  });

  it('percent-encodes a non-ASCII value', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'greeting', 'héllo');

    expect(headers['Cookie']).toBe('greeting=h%C3%A9llo');
  });

  it('writes the cookie name verbatim', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'X-Session Id', 'abc');

    expect(headers['Cookie']).toBe('X-Session Id=abc');
  });

  it('leaves other headers untouched', () => {
    const headers: Record<string, string> = {
      Authorization: 'Bearer token',
      'X-Trace-Id': 'trace-1',
    };

    appendCookie(headers, 'session_id', 'abc');

    expect(headers).toEqual({
      Authorization: 'Bearer token',
      'X-Trace-Id': 'trace-1',
      Cookie: 'session_id=abc',
    });
  });

  it('replaces an empty cookie header rather than prefixing a separator', () => {
    const headers: Record<string, string> = {Cookie: ''};

    appendCookie(headers, 'session_id', 'abc');

    expect(headers['Cookie']).toBe('session_id=abc');
  });
});
