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
import {AIMessage} from '@langchain/core/messages';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';

// The spy delegates to the real loader, so the error a user without
// `@langchain/core` sees is the real one, not a test double's.
vi.mock('../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/optional_peer.js')>();
  return {...actual, loadOptionalPeer: vi.fn(actual.loadOptionalPeer)};
});

const graph: CompiledLangGraph = {
  getState: async () => ({values: {}}),
  invoke: async () => ({messages: [new AIMessage('unreachable')]}),
};

/** Builds the error Node raises for an unresolvable ESM specifier. */
function moduleNotFound(specifier: string): Error {
  const err: Error & {code?: string} = new Error(
    `Cannot find package '${specifier}' imported from /app/index.js`,
  );
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

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

async function runAgent(agent: LangGraphAgent): Promise<void> {
  const context = createContext(agent, [
    createEvent({
      invocationId: 'test_invocation_id',
      author: 'user',
      content: {role: 'user', parts: [{text: 'test prompt'}]},
    }),
  ]);
  for await (const _event of agent.runAsync(context)) {
    // Draining the generator is what triggers the lazy load.
  }
}

describe('LangGraphAgent optional @langchain/core dependency', () => {
  beforeEach(() => {
    vi.mocked(loadOptionalPeer).mockClear();
  });

  it('does not resolve @langchain/core when the agent is constructed', () => {
    const agent = new LangGraphAgent({name: 'weather_agent', graph});

    expect(agent).toBeInstanceOf(LangGraphAgent);
    expect(loadOptionalPeer).not.toHaveBeenCalled();
  });

  it('resolves @langchain/core through the loader when the agent runs', async () => {
    const agent = new LangGraphAgent({name: 'weather_agent', graph});

    await runAgent(agent);

    expect(loadOptionalPeer).toHaveBeenCalledOnce();
    expect(vi.mocked(loadOptionalPeer).mock.calls[0][0]).toEqual({
      packageName: '@langchain/core',
      feature: 'LangGraphAgent',
    });
  });

  it('names the agent and the install command when @langchain/core is missing', async () => {
    const agent = new LangGraphAgent({name: 'weather_agent', graph});
    await runAgent(agent);
    const peer = vi.mocked(loadOptionalPeer).mock.calls[0][0];

    // The loader is the real one, so this is the message the user gets when
    // the dynamic import fails to resolve the package.
    const rejected = loadOptionalPeer(peer, () => {
      throw moduleNotFound('@langchain/core');
    });

    await expect(rejected).rejects.toThrow(/LangGraphAgent requires/);
    await expect(rejected).rejects.toThrow(/npm install @langchain\/core/);
  });
});
