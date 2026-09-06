/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {ContextCacheConfig} from '../../src/agents/context_cache_config.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {
  resolveCacheConfig,
  useOneHourTtl,
} from '../../src/models/prompt_cache.js';

/** Builds a cache config, defaulting every field the test does not name. */
function cacheConfig(
  overrides: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  return {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 0, ...overrides};
}

/** Builds a request carrying only the fields the resolver reads. */
function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

describe('resolveCacheConfig', () => {
  it('resolves to nothing when the request carries no cache config', () => {
    expect(resolveCacheConfig(request())).toBeUndefined();
  });

  it('resolves to nothing without a config even when the size is known', () => {
    expect(
      resolveCacheConfig(request({cacheableContentsTokenCount: 100_000})),
    ).toBeUndefined();
  });

  it('honours the config when no previous prompt size is known', () => {
    const config = cacheConfig({minTokens: 5000});
    expect(resolveCacheConfig(request({cacheConfig: config}))).toBe(config);
  });

  it.each([
    [0, undefined],
    [4999, undefined],
    [5000, 'config'],
    [5001, 'config'],
  ])(
    'resolves a previous prompt of %d tokens against a minimum of 5000',
    (tokens, expected) => {
      const config = cacheConfig({minTokens: 5000});
      const resolved = resolveCacheConfig(
        request({cacheConfig: config, cacheableContentsTokenCount: tokens}),
      );
      expect(resolved).toBe(expected === undefined ? undefined : config);
    },
  );

  it('treats a prompt size of zero as a measured size, not an absent one', () => {
    const config = cacheConfig({minTokens: 1});
    expect(
      resolveCacheConfig(
        request({cacheConfig: config, cacheableContentsTokenCount: 0}),
      ),
    ).toBeUndefined();
  });
});

describe('useOneHourTtl', () => {
  it.each([
    [1, false],
    [300, false],
    [3599, false],
    [3600, true],
    [86_400, true],
  ])('reports %d seconds as %s', (ttlSeconds, expected) => {
    expect(useOneHourTtl(cacheConfig({ttlSeconds}))).toBe(expected);
  });
});
