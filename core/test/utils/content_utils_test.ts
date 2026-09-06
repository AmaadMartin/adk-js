/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isContent,
  nodeInputToUserContent,
  toUserContent,
} from '../../src/utils/content_utils.js';

describe('isContent', () => {
  it('accepts an object carrying a parts array', () => {
    expect(isContent({role: 'user', parts: []})).toBe(true);
  });

  it('rejects an object whose parts is not an array', () => {
    expect(isContent({parts: 'nope'})).toBe(false);
  });

  it('rejects an object with no parts', () => {
    expect(isContent({role: 'user'})).toBe(false);
  });

  it('rejects a non-object and null', () => {
    expect(isContent('text')).toBe(false);
    expect(isContent(null)).toBe(false);
  });
});

describe('toUserContent', () => {
  it('returns a Content unchanged, keeping its identity', () => {
    const content = {role: 'model', parts: [{text: 'hi'}]};

    expect(toUserContent(content)).toBe(content);
  });

  it('wraps a string as one user text part', () => {
    expect(toUserContent('hi')).toEqual({role: 'user', parts: [{text: 'hi'}]});
  });

  it('wraps a list of parts as one user content', () => {
    expect(toUserContent([{text: 'a'}, {text: 'b'}])).toEqual({
      role: 'user',
      parts: [{text: 'a'}, {text: 'b'}],
    });
  });
});

describe('nodeInputToUserContent', () => {
  it('re-roles a Content to user, keeping its parts', () => {
    const content = {role: 'model', parts: [{text: 'hi'}]};

    expect(nodeInputToUserContent(content)).toEqual({
      role: 'user',
      parts: [{text: 'hi'}],
    });
  });

  it('does not mutate the Content it was given', () => {
    const content = {role: 'model', parts: [{text: 'hi'}]};

    nodeInputToUserContent(content);

    expect(content.role).toBe('model');
  });

  it('wraps a string as one user text part', () => {
    expect(nodeInputToUserContent('hi')).toEqual({
      role: 'user',
      parts: [{text: 'hi'}],
    });
  });

  it('serializes any other value', () => {
    expect(nodeInputToUserContent({a: 1})).toEqual({
      role: 'user',
      parts: [{text: '{"a":1}'}],
    });
  });
});
