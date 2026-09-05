/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getTextFromContent} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('getTextFromContent', () => {
  it('returns an empty string for absent content', () => {
    expect(getTextFromContent(undefined)).toBe('');
  });

  it('returns an empty string when the content carries no parts', () => {
    expect(getTextFromContent({})).toBe('');
  });

  it('joins only the text parts, with newlines', () => {
    const content = {
      parts: [
        {text: 'first'},
        {functionCall: {name: 'roll_die', args: {sides: 6}}},
        {text: ''},
        {text: 'second'},
      ],
    };

    expect(getTextFromContent(content)).toBe('first\nsecond');
  });
});
