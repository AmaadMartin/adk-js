/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';

import {ContextCacheConfig} from '../agents/context_cache_config.js';

import {useOneHourTtl} from './prompt_cache.js';

/** Options for {@link applyCacheBreakpoints}. */
export interface CacheBreakpointOptions {
  /** Cache configuration for the request. */
  cacheConfig: ContextCacheConfig;

  /** System instruction to mark, if the request carries one. */
  system?: string;

  /** Conversation to mark, modified in place. */
  messages: Anthropic.MessageParam[];

  /** Tool definitions to mark, modified in place. */
  tools: Anthropic.Tool[];
}

/** Maps the configured cache lifetime onto one Claude actually offers. */
function toCacheControl(
  cacheConfig: ContextCacheConfig,
): Anthropic.CacheControlEphemeral {
  return useOneHourTtl(cacheConfig)
    ? {type: 'ephemeral', ttl: '1h'}
    : {type: 'ephemeral'};
}

/**
 * Puts a cache breakpoint at the end of the conversation so far.
 *
 * The search runs backwards because a turn can end in a reasoning block, which
 * Claude refuses to cache, or carry no blocks at all once parts Claude cannot
 * receive have been dropped.
 *
 * @param messages Conversation to mark, modified in place.
 * @param cacheControl Breakpoint to attach.
 */
function markLastCacheableMessageBlock(
  messages: Anthropic.MessageParam[],
  cacheControl: Anthropic.CacheControlEphemeral,
): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = messages[index].content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = content[blockIndex];
      // Claude rejects a cache breakpoint on a reasoning block.
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        continue;
      }
      block.cache_control = cacheControl;
      return;
    }
  }
}

/**
 * Marks the reusable prefix of a request so Claude bills it as a cache hit.
 *
 * Claude charges the full input rate for the whole prompt on every turn unless
 * a block carries a breakpoint. A breakpoint tells it to store the prefix
 * ending at that block and to serve that prefix at the much lower cache-read
 * rate on later turns.
 *
 * Claude reads the prompt as tools, then system, then messages, so a breakpoint
 * on each of the three keeps the levels above a change still cached: editing
 * the conversation leaves the tools and the system instruction cached, and
 * editing the system instruction leaves the tools cached. Claude allows four
 * breakpoints per request and these are three of them.
 *
 * The conversation breakpoint moves to the end of each request, and Claude
 * finds the previous one by looking back at most twenty blocks. A turn that
 * adds more blocks than that, such as one calling nine or more tools at once,
 * therefore rewrites the conversation cache instead of reading it. The tools
 * and system breakpoints are unaffected, so the stable head of the prompt is
 * still served from the cache.
 *
 * @return The system instruction to send. Carrying a breakpoint turns it into
 *   a block list, so it is returned rather than modified in place. Undefined
 *   when the request has no system instruction.
 */
export function applyCacheBreakpoints({
  cacheConfig,
  system,
  messages,
  tools,
}: CacheBreakpointOptions): Anthropic.TextBlockParam[] | undefined {
  const cacheControl = toCacheControl(cacheConfig);

  if (tools.length) {
    tools[tools.length - 1].cache_control = cacheControl;
  }

  markLastCacheableMessageBlock(messages, cacheControl);

  if (!system) {
    return undefined;
  }
  return [{type: 'text', text: system, cache_control: cacheControl}];
}
