/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  canonicalToolsFor,
  createSession,
  refreshCanonicalTools,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

function makeContext(agent: LlmAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-tools',
    agent,
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u',
      lastUpdateTime: Date.now(),
    }),
    pluginManager: new PluginManager(),
  });
}

function makeAgent(withTool: boolean): LlmAgent {
  return new LlmAgent({
    name: 'agent',
    model: 'gemini-2.0-flash',
    tools: withTool
      ? [
          new FunctionTool({
            name: 'ping',
            description: 'ping',
            execute: () => 'pong',
          }),
        ]
      : [],
  });
}

describe('canonicalToolsFor', () => {
  it('resolves the agent tools once and reuses them', async () => {
    const agent = makeAgent(true);
    const context = makeContext(agent);
    const resolve = vi.spyOn(agent, 'canonicalTools');

    const first = await canonicalToolsFor(agent, context);
    const second = await canonicalToolsFor(agent, context);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.map((tool) => tool.name)).toEqual(['ping']);
  });

  it('treats an agent with no tools as resolved, not as a miss', async () => {
    const agent = makeAgent(false);
    const context = makeContext(agent);
    const resolve = vi.spyOn(agent, 'canonicalTools');

    expect(await canonicalToolsFor(agent, context)).toEqual([]);
    expect(await canonicalToolsFor(agent, context)).toEqual([]);

    expect(context.canonicalToolsCache).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('refreshCanonicalTools', () => {
  it('replaces the tools a previous model step cached', async () => {
    const agent = makeAgent(true);
    const context = makeContext(agent);
    const stale = await canonicalToolsFor(agent, context);

    const fresh = await refreshCanonicalTools(agent, context);

    expect(fresh).not.toBe(stale);
    expect(context.canonicalToolsCache).toBe(fresh);
  });
});
