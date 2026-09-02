/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import type {ContextCacheConfig} from '../../src/agents/context_cache_config.js';
import type {LlmRequest} from '../../src/models/llm_request.js';
import {
  resolveCacheConfig,
  useOneHourTtl,
} from '../../src/models/prompt_cache.js';

function cacheConfig(
  overrides: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  return {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 0, ...overrides};
}

function request(
  config?: ContextCacheConfig,
  previousPromptTokens?: number,
): LlmRequest {
  return {
    model: 'test-model',
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: config,
    cacheableContentsTokenCount: previousPromptTokens,
  };
}

describe('resolveCacheConfig', () => {
  it('does not cache a request that carries no config', () => {
    expect(resolveCacheConfig(request())).toBeUndefined();
  });

  it('reads the prompt size only after a config is known to exist', () => {
    expect(resolveCacheConfig(request(undefined, 10_000))).toBeUndefined();
  });

  it('caches before the first prompt size is known', () => {
    const config = cacheConfig({minTokens: 5000});

    expect(resolveCacheConfig(request(config))).toBe(config);
  });

  it.each([
    {previousPromptTokens: 0, cached: false},
    {previousPromptTokens: 4999, cached: false},
    {previousPromptTokens: 5000, cached: true},
    {previousPromptTokens: 5001, cached: true},
  ])(
    'gates a previous prompt of $previousPromptTokens tokens on minTokens',
    ({previousPromptTokens, cached}) => {
      const config = cacheConfig({minTokens: 5000});

      const resolved = resolveCacheConfig(
        request(config, previousPromptTokens),
      );

      expect(resolved).toBe(cached ? config : undefined);
    },
  );

  it('treats a prompt size of zero as a size, not an absent one', () => {
    const config = cacheConfig({minTokens: 1});

    expect(resolveCacheConfig(request(config, 0))).toBeUndefined();
  });

  it('does not modify the request', () => {
    const llmRequest = request(cacheConfig({minTokens: 5000}), 10);
    const before = structuredClone(llmRequest);

    resolveCacheConfig(llmRequest);

    expect(llmRequest).toEqual(before);
  });
});

describe('useOneHourTtl', () => {
  it.each([
    {ttlSeconds: 1, expected: false},
    {ttlSeconds: 300, expected: false},
    {ttlSeconds: 3599, expected: false},
    {ttlSeconds: 3600, expected: true},
    {ttlSeconds: 86_400, expected: true},
  ])(
    'asks for the long cache at $ttlSeconds seconds: $expected',
    ({ttlSeconds, expected}) => {
      expect(useOneHourTtl(cacheConfig({ttlSeconds}))).toBe(expected);
    },
  );
});
