/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CacheMetadata} from '@google/adk';
import {describe, expect, it} from 'vitest';

const NOW_SECONDS = 1_700_000_000;

const FINGERPRINT_ONLY: CacheMetadata = {
  fingerprint: 'abcdef0123456789',
  contentsCount: 3,
};

function activeMetadata(expireTime: number): CacheMetadata {
  return {
    cacheName: 'projects/123/locations/us-central1/cachedContents/456',
    expireTime,
    invocationsUsed: 7,
    fingerprint: 'abcdef0123456789',
    contentsCount: 5,
    createdAt: NOW_SECONDS - 60,
  };
}

describe('CacheMetadata narrowing', () => {
  it('exposes the active fields once cacheName is known to be set', () => {
    const metadata = activeMetadata(NOW_SECONDS + 60);
    if (metadata.cacheName === undefined) {
      expect.fail('expected active cache metadata');
    }
    expect(metadata.expireTime).toBe(NOW_SECONDS + 60);
    expect(metadata.invocationsUsed).toBe(7);
  });

  it('hides the active fields on fingerprint-only metadata', () => {
    expect(FINGERPRINT_ONLY.cacheName).toBeUndefined();
    expect(FINGERPRINT_ONLY.expireTime).toBeUndefined();
    expect(FINGERPRINT_ONLY.invocationsUsed).toBeUndefined();
  });
});
