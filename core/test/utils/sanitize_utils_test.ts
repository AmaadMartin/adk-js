/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {recursiveSmartTruncate, truncateText} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Builds an object nested `depth` levels deep under the key `next`. */
function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {leaf: 'bottom'};
  for (let i = 0; i < depth; i++) {
    node = {next: node};
  }
  return node;
}

describe('truncateText', () => {
  it('leaves a string that fits', () => {
    expect(truncateText('short', 10)).toEqual({
      text: 'short',
      truncated: false,
    });
  });

  it('cuts a string that does not fit and marks it', () => {
    expect(truncateText('abcdef', 3)).toEqual({
      text: 'abc...[TRUNCATED]',
      truncated: true,
    });
  });

  it('leaves a long string whole when the limit is -1', () => {
    const long = 'x'.repeat(5000);
    expect(truncateText(long, -1)).toEqual({text: long, truncated: false});
  });
});

describe('recursiveSmartTruncate', () => {
  it('truncates a long string and reports the loss', () => {
    const result = recursiveSmartTruncate('a'.repeat(20), 5);
    expect(result.value).toBe('aaaaa...[TRUNCATED]');
    expect(result.truncated).toBe(true);
  });

  it('walks nested objects and arrays element-wise', () => {
    const result = recursiveSmartTruncate(
      {outer: [{inner: 'abcdefgh'}, 'ijklmnop', 7, true, null]},
      4,
    );
    expect(result.value).toEqual({
      outer: [
        {inner: 'abcd...[TRUNCATED]'},
        'ijkl...[TRUNCATED]',
        7,
        true,
        null,
      ],
    });
    expect(result.truncated).toBe(true);
  });

  it('walks a class instance through its own enumerable properties', () => {
    class ToolArgs {
      constructor(
        readonly query: string,
        readonly apiKey: string,
      ) {}
    }
    const result = recursiveSmartTruncate(new ToolArgs('weather', 'sk-1'), -1);
    expect(result.value).toEqual({query: 'weather', apiKey: '[REDACTED]'});
  });

  it('leaves a long string whole when maxLength is -1', () => {
    const traceback = 'stack line\n'.repeat(500);
    const result = recursiveSmartTruncate({traceback}, -1);
    expect(result.value).toEqual({traceback});
    expect(result.truncated).toBe(false);
  });

  it.each([
    'client_secret',
    'access_token',
    'refresh_token',
    'id_token',
    'api_key',
    'password',
    'private_key',
    'proxy_authorization',
    'google_access_id',
    'sig',
    'signature',
    'token',
    'secret',
    'authorization',
    'x_api_key',
    'x_amz_credential',
    'x_amz_signature',
    'x_goog_credential',
    'x_goog_security_token',
    'x_goog_signature',
  ])('redacts the value of %s', (key) => {
    const result = recursiveSmartTruncate({[key]: 'super-secret'}, -1);
    expect(result.value).toEqual({[key]: '[REDACTED]'});
  });

  it.each(['AUTHORIZATION', 'X-Api-Key', 'Access-Token', 'temp:oauth_state'])(
    'redacts %s, matching case-insensitively with - and _ equivalent',
    (key) => {
      const result = recursiveSmartTruncate({[key]: 'super-secret'}, -1);
      expect(result.value).toEqual({[key]: '[REDACTED]'});
    },
  );

  it.each(['apiKey', 'accessToken', 'clientSecret', 'privateKey'])(
    'redacts the camelCase spelling %s that a JavaScript payload uses',
    (key) => {
      const result = recursiveSmartTruncate({[key]: 'super-secret'}, -1);
      expect(result.value).toEqual({[key]: '[REDACTED]'});
    },
  );

  it('does not report truncation for redaction alone', () => {
    const result = recursiveSmartTruncate({token: 'super-secret'}, -1);
    expect(result.truncated).toBe(false);
  });

  it('leaves a key that merely contains a sensitive word alone', () => {
    const result = recursiveSmartTruncate({tokenCount: 42}, -1);
    expect(result.value).toEqual({tokenCount: 42});
  });

  it('replaces a back-reference without reporting truncation', () => {
    const cyclic: Record<string, unknown> = {name: 'root'};
    cyclic['self'] = cyclic;
    const result = recursiveSmartTruncate(cyclic, -1);
    expect(result.value).toEqual({name: 'root', self: '[CIRCULAR_REFERENCE]'});
    expect(result.truncated).toBe(false);
  });

  it('keeps a repeated sibling that is not an ancestor', () => {
    const shared = {id: 1};
    const result = recursiveSmartTruncate({a: shared, b: shared}, -1);
    expect(result.value).toEqual({a: {id: 1}, b: {id: 1}});
  });

  it('replaces a value nested past the depth cap and reports the loss', () => {
    const result = recursiveSmartTruncate(nest(60), -1);
    expect(JSON.stringify(result.value)).toContain('[MAX_DEPTH_EXCEEDED]');
    expect(result.truncated).toBe(true);
  });

  it('keeps a value nested just inside the depth cap', () => {
    const result = recursiveSmartTruncate(nest(40), -1);
    expect(JSON.stringify(result.value)).toContain('bottom');
    expect(result.truncated).toBe(false);
  });

  it('stops an over-wide array at the node budget', () => {
    const wide = Array.from({length: 100_005}, (_, i) => i);
    const result = recursiveSmartTruncate(wide, -1);
    expect(result.value).toContain('[SANITIZE_BUDGET_EXCEEDED]');
    expect(result.truncated).toBe(true);
  });

  it('stops an over-wide object at the node budget', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100_005; i++) {
      wide[`k${i}`] = i;
    }
    const result = recursiveSmartTruncate(wide, -1);
    expect(result.value).toHaveProperty(
      '[SANITIZE_BUDGET_EXCEEDED]',
      '[SANITIZE_BUDGET_EXCEEDED]',
    );
    expect(result.truncated).toBe(true);
  });

  it('serializes a value JSON.stringify cannot represent', () => {
    const result = recursiveSmartTruncate({big: 9007199254740993n}, -1);
    expect(result.value).toEqual({big: '9007199254740993'});
    expect(() => JSON.stringify(result.value)).not.toThrow();
  });

  it('keeps a Date as the value it serializes to', () => {
    const result = recursiveSmartTruncate(
      {at: new Date('2026-01-02T03:04:05.000Z')},
      -1,
    );
    expect(result.value).toEqual({at: '2026-01-02T03:04:05.000Z'});
  });

  it('passes undefined through unchanged', () => {
    expect(recursiveSmartTruncate(undefined, -1)).toEqual({
      value: undefined,
      truncated: false,
    });
  });
});
