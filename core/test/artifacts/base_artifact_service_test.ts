/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createArtifactVersion} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createArtifactVersion', () => {
  it('defaults customMetadata to an empty object', () => {
    const version = createArtifactVersion({
      version: 0,
      canonicalUri: 'memory://apps/a/users/u/artifacts/f.txt/versions/0',
    });

    expect(version.customMetadata).toEqual({});
  });

  it('stamps createTime in Unix seconds', () => {
    const before = Date.now() / 1000;
    const version = createArtifactVersion({
      version: 0,
      canonicalUri: 'memory://apps/a/users/u/artifacts/f.txt/versions/0',
    });
    const after = Date.now() / 1000;

    expect(version.createTime).toBeGreaterThanOrEqual(before);
    expect(version.createTime).toBeLessThanOrEqual(after);
    // Milliseconds are about 1000 times larger, so this bound catches the unit.
    expect(version.createTime).toBeLessThan(Date.now());
  });

  it('keeps the values the caller supplies', () => {
    const version = createArtifactVersion({
      version: 3,
      canonicalUri: 'file:///tmp/f.txt',
      customMetadata: {owner: 'alice'},
      createTime: 1700000000,
      mimeType: 'text/plain',
    });

    expect(version).toEqual({
      version: 3,
      canonicalUri: 'file:///tmp/f.txt',
      customMetadata: {owner: 'alice'},
      createTime: 1700000000,
      mimeType: 'text/plain',
    });
  });

  it('leaves mimeType undefined when the caller omits it', () => {
    const version = createArtifactVersion({
      version: 0,
      canonicalUri: 'file:///tmp/f.txt',
    });

    expect(version.mimeType).toBeUndefined();
  });
});
