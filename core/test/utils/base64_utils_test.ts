/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {maybeBase64ToBytes} from '../../src/utils/base64_utils.js';

describe('maybeBase64ToBytes', () => {
  it('decodes standard base64', () => {
    const encoded = Buffer.from('hello world', 'utf8').toString('base64');

    expect(maybeBase64ToBytes(encoded)?.toString('utf8')).toEqual(
      'hello world',
    );
  });

  it('decodes url-safe base64', () => {
    // These bytes encode to '+/' in the standard alphabet and '-_' in the
    // url-safe one, so only the url-safe branch can decode them.
    const raw = Buffer.from([0xfb, 0xff, 0xfe]);
    const urlSafe = raw.toString('base64url');

    expect(urlSafe).toContain('-');
    expect(urlSafe).toContain('_');
    expect(maybeBase64ToBytes(urlSafe)).toEqual(raw);
  });

  it('returns undefined when the length is not a multiple of four', () => {
    expect(maybeBase64ToBytes('x')).toBeUndefined();
  });

  it('returns undefined for characters outside both alphabets', () => {
    expect(maybeBase64ToBytes('col1,col2\n1,2\nab')).toBeUndefined();
  });

  it('returns undefined when standard and url-safe characters are mixed', () => {
    expect(maybeBase64ToBytes('a+b_')).toBeUndefined();
  });

  it('returns an empty buffer for an empty string', () => {
    expect(maybeBase64ToBytes('')).toEqual(Buffer.alloc(0));
  });
});
