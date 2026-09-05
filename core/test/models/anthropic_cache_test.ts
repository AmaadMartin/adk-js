/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import type {ContextCacheConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {applyCacheBreakpoints} from '../../src/models/anthropic_cache.js';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

const EPHEMERAL: Anthropic.CacheControlEphemeral = {type: 'ephemeral'};

/**
 * These cases reach {@link applyCacheBreakpoints} directly because the
 * provider's own converter never produces them: it always builds a block list,
 * and it always has something cacheable in the first turn.
 */
describe('applyCacheBreakpoints', () => {
  it('skips a turn whose content is a plain string', () => {
    const messages: Anthropic.MessageParam[] = [
      {role: 'user', content: [{type: 'text', text: 'Cacheable'}]},
      {role: 'assistant', content: 'A plain string, not a block list'},
    ];

    applyCacheBreakpoints({
      cacheConfig: CACHE_CONFIG,
      messages,
      tools: [],
    });

    expect(messages[0].content).toEqual([
      {type: 'text', text: 'Cacheable', cache_control: EPHEMERAL},
    ]);
    expect(messages[1].content).toBe('A plain string, not a block list');
  });

  it('marks nothing in a conversation with no cacheable block', () => {
    const messages: Anthropic.MessageParam[] = [
      {role: 'assistant', content: []},
      {
        role: 'assistant',
        content: [{type: 'thinking', thinking: 'quietly', signature: 'sig'}],
      },
    ];
    const tools: Anthropic.Tool[] = [
      {name: 'only', input_schema: {type: 'object'}},
    ];

    const system = applyCacheBreakpoints({
      cacheConfig: CACHE_CONFIG,
      system: 'Be helpful',
      messages,
      tools,
    });

    expect(messages[1].content).toEqual([
      {type: 'thinking', thinking: 'quietly', signature: 'sig'},
    ]);
    expect(tools[0].cache_control).toEqual(EPHEMERAL);
    expect(system).toEqual([
      {type: 'text', text: 'Be helpful', cache_control: EPHEMERAL},
    ]);
  });
});
