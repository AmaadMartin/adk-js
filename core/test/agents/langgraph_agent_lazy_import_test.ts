/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompiledLangGraph,
  Event,
  InvocationContext,
  LangGraphAgent,
  PluginManager,
  createEvent,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// Simulates `@langchain/core` not being installed. It is an optional peer
// dependency, so nothing may resolve it until the agent actually runs.
vi.mock('@langchain/core/messages', () => {
  throw new Error("Cannot find module '@langchain/core/messages'");
});

const graph: CompiledLangGraph = {
  getState: async () => ({values: {}}),
  invoke: async () => ({messages: [{content: 'unreachable'}]}),
};

function createContext(agent: LangGraphAgent, events: Event[]) {
  return new InvocationContext({
    invocationId: 'test_invocation_id',
    agent,
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager(),
  });
}

describe('LangGraphAgent optional @langchain/core dependency', () => {
  it('imports and constructs without @langchain/core installed', () => {
    expect(LangGraphAgent).toBeTypeOf('function');
    expect(
      () => new LangGraphAgent({name: 'weather_agent', graph}),
    ).not.toThrow();
  });

  it('surfaces the missing module only when the agent runs', async () => {
    const agent = new LangGraphAgent({name: 'weather_agent', graph});
    const context = createContext(agent, [
      createEvent({
        invocationId: 'test_invocation_id',
        author: 'user',
        content: {role: 'user', parts: [{text: 'test prompt'}]},
      }),
    ]);

    await expect(async () => {
      for await (const _event of agent.runAsync(context)) {
        // Draining the generator is what triggers the dynamic import.
      }
    }).rejects.toThrow(/There was an error when mocking a module/);
  });
});
