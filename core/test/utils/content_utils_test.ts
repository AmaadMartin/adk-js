/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {contentUnionToText} from '../../src/utils/content_utils.js';

describe('contentUnionToText', () => {
  it('returns strings unchanged', () => {
    expect(contentUnionToText('be brief')).toBe('be brief');
  });

  it('joins the text of content parts', () => {
    expect(contentUnionToText({parts: [{text: 'a'}, {text: 'b'}]})).toBe(
      'a\nb',
    );
    expect(contentUnionToText(['a', {text: 'b'}])).toBe('a\nb');
  });

  it('takes the text of a single part', () => {
    expect(contentUnionToText({text: 'a'})).toBe('a');
  });
});
