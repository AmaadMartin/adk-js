/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {appendCookie, checkCookieValue} from '../../src/utils/cookie_utils.js';

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

  it('writes a base64 value verbatim', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'session_id', 'dGVzdHNlc3Npb24=');

    expect(headers['Cookie']).toBe('session_id=dGVzdHNlc3Npb24=');
  });

  it('does not re-encode a value that already carries percent escapes', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'session_id', 's%3Aabc.def');

    expect(headers['Cookie']).toBe('session_id=s%3Aabc.def');
  });

  it('writes a non-ASCII value verbatim', () => {
    const headers: Record<string, string> = {};

    appendCookie(headers, 'greeting', 'héllo');

    expect(headers['Cookie']).toBe('greeting=héllo');
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

describe('checkCookieValue', () => {
  it('accepts a value that carries no separator', () => {
    expect(() =>
      checkCookieValue('session_id', 'dGVzdHNlc3Npb24='),
    ).not.toThrow();
  });

  it.each([
    ['a semicolon', 'abc; admin=true'],
    ['a carriage return', 'abc\rX-Admin: true'],
    ['a line feed', 'abc\nX-Admin: true'],
    ['a NUL', 'abc\0def'],
  ])('rejects a value containing %s', (_label, value) => {
    expect(() => checkCookieValue('session_id', value)).toThrow(
      "Invalid value for cookie parameter 'session_id'",
    );
  });
});
