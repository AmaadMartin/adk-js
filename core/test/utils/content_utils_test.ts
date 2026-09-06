/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {toUserContent} from '../../src/utils/content_utils.js';

describe('toUserContent', () => {
  it('wraps a string in a single text part', () => {
    expect(toUserContent('hello')).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('re-roles a Content to user and keeps its parts', () => {
    expect(toUserContent({role: 'model', parts: [{text: 'hi'}]})).toEqual({
      role: 'user',
      parts: [{text: 'hi'}],
    });
  });

  it('JSON-encodes anything else into one text part', () => {
    expect(toUserContent({task: 'primes', limit: 10})).toEqual({
      role: 'user',
      parts: [{text: '{"task":"primes","limit":10}'}],
    });
  });

  it('encodes a number rather than dropping it', () => {
    expect(toUserContent(42)).toEqual({role: 'user', parts: [{text: '42'}]});
  });
});
