/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TestAudioCacheConfig` and `TestRealtimeCacheEntry` are ported from
 * `google/adk-python` `tests/unittests/live/test_audio_cache_manager.py` @
 * main, and keep their Python test names verbatim.
 *
 * `TestRealtimeCacheEntry::test_unknown_fields_are_rejected` has no
 * counterpart: it asserts that pydantic's `extra='forbid'` raises at runtime,
 * and adk-js's `RealtimeCacheEntry` is a structural interface that TypeScript
 * erases at compile time.
 */

import {
  AudioCacheConfig,
  AudioCacheManager,
  RealtimeCacheEntry,
  createAudioCacheConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {toBase64} from './audio_cache_manager_test_utils.js';

const DEFAULT_CONFIG: AudioCacheConfig = {
  maxCacheSizeBytes: 10 * 1024 * 1024,
  maxCacheDurationSeconds: 300,
  autoFlushThreshold: 100,
};

describe('TestAudioCacheConfig', () => {
  it('test_default_values', () => {
    const config = createAudioCacheConfig();

    expect(config.maxCacheSizeBytes).toBe(10 * 1024 * 1024);
    expect(config.maxCacheDurationSeconds).toBe(300);
    expect(config.autoFlushThreshold).toBe(100);
  });

  it('test_custom_values', () => {
    const config = createAudioCacheConfig({
      maxCacheSizeBytes: 5 * 1024 * 1024,
      maxCacheDurationSeconds: 120,
      autoFlushThreshold: 50,
    });

    expect(config.maxCacheSizeBytes).toBe(5 * 1024 * 1024);
    expect(config.maxCacheDurationSeconds).toBe(120);
    expect(config.autoFlushThreshold).toBe(50);
  });
});

describe('TestRealtimeCacheEntry', () => {
  it('test_accepts_the_declared_fields', () => {
    const entry: RealtimeCacheEntry = {
      role: 'user',
      data: {data: toBase64('x'), mimeType: 'audio/pcm'},
      timestamp: 1500,
    };

    expect(entry.role).toBe('user');
    expect(entry.timestamp).toBe(1500);
  });
});

describe('createAudioCacheConfig', () => {
  it('should fill each field independently', () => {
    expect(createAudioCacheConfig({maxCacheSizeBytes: 1})).toEqual({
      ...DEFAULT_CONFIG,
      maxCacheSizeBytes: 1,
    });
    expect(createAudioCacheConfig({maxCacheDurationSeconds: 2})).toEqual({
      ...DEFAULT_CONFIG,
      maxCacheDurationSeconds: 2,
    });
    expect(createAudioCacheConfig({autoFlushThreshold: 3})).toEqual({
      ...DEFAULT_CONFIG,
      autoFlushThreshold: 3,
    });
  });

  it('should not mutate the object it is given', () => {
    const params = {autoFlushThreshold: 7};

    const config = createAudioCacheConfig(params);

    expect(params).toEqual({autoFlushThreshold: 7});
    expect(config).not.toBe(params);
  });

  it('should accept a value adk-python accepts, without validating bounds', () => {
    // adk-python's AudioCacheConfig is a plain class with no validators, so
    // the factory must not reject what the reference stores.
    expect(createAudioCacheConfig({maxCacheSizeBytes: -1})).toEqual({
      ...DEFAULT_CONFIG,
      maxCacheSizeBytes: -1,
    });
  });
});

describe('AudioCacheManager config', () => {
  it('should expose the defaults when constructed with no config', () => {
    expect(new AudioCacheManager().config).toEqual(DEFAULT_CONFIG);
  });

  it('should expose the config it was constructed with', () => {
    const config = createAudioCacheConfig({autoFlushThreshold: 8});

    expect(new AudioCacheManager(config).config).toBe(config);
  });
});
