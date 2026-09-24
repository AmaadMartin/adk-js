/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {toUserContent} from '../../src/utils/content_utils.js';

describe('toUserContent', () => {
  it('wraps a string in one user-role text part', () => {
    expect(toUserContent('fix the flake')).toEqual({
      role: 'user',
      parts: [{text: 'fix the flake'}],
    });
  });

  it('keeps the parts of a Content and re-roles it to user', () => {
    const given: Content = {role: 'model', parts: [{text: 'hello'}]};

    expect(toUserContent(given)).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('serializes any other value to JSON so a text model can read it', () => {
    expect(toUserContent({bug: 42})).toEqual({
      role: 'user',
      parts: [{text: '{"bug":42}'}],
    });
  });
});
