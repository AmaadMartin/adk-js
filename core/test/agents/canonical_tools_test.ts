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
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {clearCanonicalToolsCache} from '../../src/agents/canonical_tools.js';
import {ScriptedLlm} from '../workflow/test_helpers.js';

function makeContext(
  agent: LlmAgent,
  userContent?: Content,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-tools',
    agent,
    userContent,
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

describe('clearCanonicalToolsCache', () => {
  it('makes the next reader resolve the tools again', async () => {
    const agent = makeAgent(true);
    const context = makeContext(agent);
    const resolve = vi.spyOn(agent, 'canonicalTools');
    const stale = await canonicalToolsFor(agent, context);

    clearCanonicalToolsCache(context);
    const fresh = await canonicalToolsFor(agent, context);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fresh).not.toBe(stale);
    expect(context.canonicalToolsCache).toBe(fresh);
  });

  it('clears an empty resolution too, not just a populated one', async () => {
    const agent = makeAgent(false);
    const context = makeContext(agent);
    await canonicalToolsFor(agent, context);

    clearCanonicalToolsCache(context);

    expect(context.canonicalToolsCache).toBeUndefined();
  });
});

describe('canonical tools memo across a real agent run', () => {
  it('resolves once per model step, not once per invocation', async () => {
    // Two model steps: the first asks for the tool, the second answers.
    const agent = new LlmAgent({
      name: 'agent',
      model: new ScriptedLlm([
        {functionCall: {id: 'c1', name: 'ping'}},
        'done',
      ]),
      tools: [
        new FunctionTool({
          name: 'ping',
          description: 'ping',
          execute: () => 'pong',
        }),
      ],
    });
    const resolve = vi.spyOn(agent, 'canonicalTools');
    const context = makeContext(agent, {
      role: 'user',
      parts: [{text: 'ping please'}],
    });

    for await (const _ of agent.runAsync(context)) {
      // Drain the run.
    }

    // One resolution per step, rather than one for the whole invocation or
    // one per reader within a step.
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
