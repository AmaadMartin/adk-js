/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {redactInlineData} from '../../src/utils/redact_content.js';

/** Base64 of `test_image_data`. */
const IMAGE_BASE64 = 'dGVzdF9pbWFnZV9kYXRh';

describe('redactInlineData', () => {
  it('drops the media payload but keeps the MIME type', () => {
    const redacted = redactInlineData({
      role: 'user',
      parts: [{inlineData: {mimeType: 'image/png', data: IMAGE_BASE64}}],
    });

    expect(redacted.parts?.[0].inlineData?.data).toBeUndefined();
    expect(redacted.parts?.[0].inlineData?.mimeType).toBe('image/png');
    expect(JSON.stringify(redacted)).not.toContain(IMAGE_BASE64);
  });

  it('leaves a part that carries no inline data alone', () => {
    const redacted = redactInlineData({
      role: 'user',
      parts: [{text: 'Test prompt'}],
    });

    expect(redacted.parts).toEqual([{text: 'Test prompt'}]);
  });

  it('returns a content that has no parts unchanged', () => {
    const content = {role: 'user'};

    expect(redactInlineData(content)).toBe(content);
  });

  it('does not modify the input', () => {
    const content = {
      role: 'user',
      parts: [{inlineData: {mimeType: 'image/png', data: IMAGE_BASE64}}],
    };

    redactInlineData(content);

    expect(content.parts[0].inlineData.data).toBe(IMAGE_BASE64);
  });
});
