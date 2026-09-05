/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `core/src/agents/context_cache_config.ts`.
 *
 * The first block is ported from google/adk-python
 * `tests/unittests/agents/test_context_cache_config.py` (commit `8c92cdef`),
 * which covers `src/google/adk/agents/context_cache_config.py`. Each `it()`
 * name is the Python test name, so a reader can find the original.
 */

import {
  contextCacheTtlString,
  createContextCacheConfig,
  formatContextCacheConfig,
} from '@google/adk';
import {HttpOptions} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('ContextCacheConfig (ported from adk-python tests/unittests/agents/test_context_cache_config.py)', () => {
  it('test_default_values', () => {
    const config = createContextCacheConfig();

    expect(config.cacheIntervals).toBe(10);
    expect(config.ttlSeconds).toBe(1800);
    expect(config.minTokens).toBe(0);
  });

  it('test_custom_values', () => {
    const config = createContextCacheConfig({
      cacheIntervals: 15,
      ttlSeconds: 3600,
      minTokens: 1024,
    });

    expect(config.cacheIntervals).toBe(15);
    expect(config.ttlSeconds).toBe(3600);
    expect(config.minTokens).toBe(1024);
  });

  it('test_cache_intervals_validation', () => {
    expect(createContextCacheConfig({cacheIntervals: 1}).cacheIntervals).toBe(
      1,
    );
    expect(createContextCacheConfig({cacheIntervals: 100}).cacheIntervals).toBe(
      100,
    );

    expect(() => createContextCacheConfig({cacheIntervals: 0})).toThrow(
      'greater than or equal to 1',
    );
    expect(() => createContextCacheConfig({cacheIntervals: 101})).toThrow(
      'less than or equal to 100',
    );
  });

  it('test_ttl_seconds_validation', () => {
    expect(createContextCacheConfig({ttlSeconds: 1}).ttlSeconds).toBe(1);
    expect(createContextCacheConfig({ttlSeconds: 86400}).ttlSeconds).toBe(
      86400,
    );

    expect(() => createContextCacheConfig({ttlSeconds: 0})).toThrow(
      'greater than 0',
    );
    expect(() => createContextCacheConfig({ttlSeconds: -1})).toThrow(
      'greater than 0',
    );
  });

  it('test_min_tokens_validation', () => {
    expect(createContextCacheConfig({minTokens: 0}).minTokens).toBe(0);
    expect(createContextCacheConfig({minTokens: 1024}).minTokens).toBe(1024);

    expect(() => createContextCacheConfig({minTokens: -1})).toThrow(
      'greater than or equal to 0',
    );
  });

  it('test_ttl_string_property', () => {
    expect(
      contextCacheTtlString(createContextCacheConfig({ttlSeconds: 1800})),
    ).toBe('1800s');
    expect(
      contextCacheTtlString(createContextCacheConfig({ttlSeconds: 3600})),
    ).toBe('3600s');
  });

  it('test_str_representation', () => {
    const config = createContextCacheConfig({
      cacheIntervals: 15,
      ttlSeconds: 3600,
      minTokens: 1024,
    });

    expect(formatContextCacheConfig(config)).toBe(
      'ContextCacheConfig(cacheIntervals=15, ttl=3600s, minTokens=1024, ' +
        'createHttpOptions=undefined)',
    );
  });

  it('test_str_representation_defaults', () => {
    expect(formatContextCacheConfig(createContextCacheConfig())).toBe(
      'ContextCacheConfig(cacheIntervals=10, ttl=1800s, minTokens=0, ' +
        'createHttpOptions=undefined)',
    );
  });

  it('test_pydantic_model_validation', () => {
    const raw = {cacheIntervals: 10, extraField: 'not_allowed'};

    expect(() => createContextCacheConfig(raw)).toThrow(/extra/i);
    expect(() => createContextCacheConfig(raw)).toThrow('extraField');
  });

  it('test_realistic_scenarios', () => {
    const devConfig = createContextCacheConfig({
      cacheIntervals: 5,
      ttlSeconds: 600,
      minTokens: 0,
    });
    expect(devConfig.cacheIntervals).toBe(5);
    expect(devConfig.ttlSeconds).toBe(600);

    const prodConfig = createContextCacheConfig({
      cacheIntervals: 20,
      ttlSeconds: 7200,
      minTokens: 2048,
    });
    expect(prodConfig.cacheIntervals).toBe(20);
    expect(prodConfig.ttlSeconds).toBe(7200);
    expect(prodConfig.minTokens).toBe(2048);

    const conservativeConfig = createContextCacheConfig({
      cacheIntervals: 3,
      ttlSeconds: 300,
      minTokens: 4096,
    });
    expect(conservativeConfig.cacheIntervals).toBe(3);
    expect(conservativeConfig.ttlSeconds).toBe(300);
    expect(conservativeConfig.minTokens).toBe(4096);
  });
});

describe('ContextCacheConfig (adk-js additions)', () => {
  it('leaves the params object it is given unchanged', () => {
    const params = {cacheIntervals: 15};

    createContextCacheConfig(params);

    expect(params).toEqual({cacheIntervals: 15});
  });

  it('rejects a field that is not an integer', () => {
    expect(() => createContextCacheConfig({cacheIntervals: 1.5})).toThrow(
      'cacheIntervals must be an integer; got 1.5.',
    );
    expect(() => createContextCacheConfig({ttlSeconds: 2.5})).toThrow(
      'ttlSeconds must be an integer; got 2.5.',
    );
    expect(() => createContextCacheConfig({minTokens: Number.NaN})).toThrow(
      'minTokens must be an integer; got NaN.',
    );
  });

  it('keeps createHttpOptions and renders it with JSON.stringify', () => {
    const createHttpOptions: HttpOptions = {timeout: 10000};

    const config = createContextCacheConfig({createHttpOptions});

    expect(config.createHttpOptions).toEqual({timeout: 10000});
    expect(formatContextCacheConfig(config)).toBe(
      'ContextCacheConfig(cacheIntervals=10, ttl=1800s, minTokens=0, ' +
        'createHttpOptions={"timeout":10000})',
    );
  });
});
