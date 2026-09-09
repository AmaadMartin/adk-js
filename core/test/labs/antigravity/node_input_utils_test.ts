/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the node-input conversion an `AntigravityAgent` node runs on.
 *
 * No adk-python counterpart: the reference reuses its own
 * `utils.content_utils.to_user_content`, which adk-js does not have with these
 * semantics.
 */

import {describe, expect, it} from 'vitest';
import {toNodeInputContent} from '../../../src/labs/antigravity/node_input_utils.js';

describe('toNodeInputContent', () => {
  it('re-roles an existing Content to user and keeps its parts', () => {
    const input = {role: 'model', parts: [{text: 'hello'}]};

    expect(toNodeInputContent(input)).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('leaves the caller Content untouched', () => {
    const input = {role: 'model', parts: [{text: 'hello'}]};

    toNodeInputContent(input);

    expect(input.role).toBe('model');
  });

  it('wraps a string in one text part', () => {
    expect(toNodeInputContent('Fix the flake.')).toEqual({
      role: 'user',
      parts: [{text: 'Fix the flake.'}],
    });
  });

  it('JSON-encodes anything else into one text part', () => {
    expect(toNodeInputContent({bug: 42})).toEqual({
      role: 'user',
      parts: [{text: '{"bug":42}'}],
    });
  });

  it('treats a partless object as a plain value, not as Content', () => {
    // `isContent` asks for an array `parts`, so an object without one is data.
    expect(toNodeInputContent({role: 'user'})).toEqual({
      role: 'user',
      parts: [{text: '{"role":"user"}'}],
    });
  });
});
