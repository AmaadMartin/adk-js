/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool} from '../tools/base_tool.js';

import {InvocationContext} from './invocation_context.js';
import type {LlmAgent} from './llm_agent.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * The agent's canonical tools for the current model step, resolved once.
 *
 * Resolving a tool union can mean a remote call — an MCP toolset lists its
 * tools over its transport — and several request processors need the same set
 * within one step. The first caller resolves and stores the set on
 * {@link InvocationContext.canonicalToolsCache}; the rest read it back.
 *
 * The cache holds the resolution of one model step, not of the whole
 * invocation: a tool set can change between steps, and adk-python refreshes it
 * per step for that reason (`flows/llm_flows/base_llm_flow.py`). An agent with
 * no tools caches the empty array, which is a hit rather than a miss.
 *
 * @param agent The agent whose tools to resolve.
 * @param ctx The invocation holding the cache.
 * @returns The agent's resolved tools.
 */
export async function canonicalToolsFor(
  agent: LlmAgent,
  ctx: InvocationContext,
): Promise<BaseTool[]> {
  const cached = ctx.canonicalToolsCache;
  if (cached !== undefined) {
    return cached;
  }
  const tools = await agent.canonicalTools(new ReadonlyContext(ctx));
  ctx.canonicalToolsCache = tools;
  return tools;
}

/**
 * Drops the tools cached for the model step that just ended.
 *
 * Called where a step begins, so the memo covers exactly one step whichever
 * reader happens to fill it. Leaving it to a particular request processor
 * would freeze the first resolution for an agent whose processor list omits
 * that one.
 *
 * @param ctx The invocation holding the cache.
 */
export function clearCanonicalToolsCache(ctx: InvocationContext): void {
  ctx.canonicalToolsCache = undefined;
}
