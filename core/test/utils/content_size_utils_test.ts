/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {contentSize} from '../../src/utils/content_size_utils.js';

describe('contentSize', () => {
  it('measures nothing for absent content', () => {
    expect(contentSize(undefined)).toBe(0);
    expect(contentSize(null)).toBe(0);
  });

  it('measures nothing for content without parts', () => {
    expect(contentSize({})).toBe(0);
    expect(contentSize({parts: []})).toBe(0);
  });

  it('measures text in UTF-8 bytes, not characters', () => {
    expect(contentSize({parts: [{text: 'Hello World'}]})).toBe(11);
    // Four characters, ten UTF-8 bytes.
    expect(contentSize({parts: [{text: 'né€😀'}]})).toBe(10);
  });

  it('measures inline data as its decoded byte length', () => {
    // 'Hello', one padding character.
    expect(
      contentSize({
        parts: [{inlineData: {data: 'SGVsbG8=', mimeType: 'text/plain'}}],
      }),
    ).toBe(5);
    // 'A', two padding characters.
    expect(
      contentSize({
        parts: [{inlineData: {data: 'QQ==', mimeType: 'text/plain'}}],
      }),
    ).toBe(1);
    // 'Hello!', no padding at all.
    expect(
      contentSize({
        parts: [{inlineData: {data: 'SGVsbG8h', mimeType: 'text/plain'}}],
      }),
    ).toBe(6);
    expect(
      contentSize({parts: [{inlineData: {data: '', mimeType: 'text/plain'}}]}),
    ).toBe(0);
  });

  it('measures a structured part as its JSON encoding', () => {
    // {"name":"fake_tool","args":{}} -> 30 bytes
    expect(
      contentSize({parts: [{functionCall: {name: 'fake_tool', args: {}}}]}),
    ).toBe(30);
  });

  it('sums text and structured parts of the same content', () => {
    expect(
      contentSize({
        parts: [
          {text: 'Hello'}, // 5 bytes
          // {"name":"t","response":{}} -> 26 bytes
          {functionResponse: {name: 't', response: {}}},
        ],
      }),
    ).toBe(31);
  });
});
