/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompiledLangGraph,
  createSession,
  Event,
  InvocationContext,
  LangGraphAgent,
  PluginManager,
} from '@google/adk';
import {AIMessage} from '@langchain/core/messages';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';

// `vi.mock` keys on the resolved module, so the loader is named by the path
// the agent itself imports rather than through the `@google/adk` barrel.
vi.mock('../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/optional_peer.js')>();
  return {...actual, loadOptionalPeer: vi.fn(actual.loadOptionalPeer)};
});

const {loadOptionalPeer: realLoadOptionalPeer} = await vi.importActual<
  typeof import('../../src/utils/optional_peer.js')
>('../../src/utils/optional_peer.js');

const loadOptionalPeerMock = vi.mocked(loadOptionalPeer);

const GRAPH: CompiledLangGraph = {
  getState: () => Promise.resolve({values: {}}),
  invoke: () => Promise.resolve({messages: [new AIMessage('response')]}),
};

function createContext(agent: LangGraphAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test_invocation_id',
    agent,
    session: createSession({
      id: 'test_session_id',
      appName: 'test_app',
      userId: 'test_user',
    }),
    pluginManager: new PluginManager(),
  });
}

async function collectEvents(
  stream: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Builds the error Node raises for an unresolvable ESM specifier. */
function moduleNotFound(specifier: string): Error {
  const err = new Error(
    `Cannot find package '${specifier}' imported from /app/index.js`,
  ) as Error & {code?: string};
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('LangGraphAgent optional peer loading', () => {
  beforeEach(() => {
    loadOptionalPeerMock.mockClear();
  });

  it('does not load @langchain/core at construction', () => {
    const agent = new LangGraphAgent({name: 'weather_agent', graph: GRAPH});

    expect(loadOptionalPeerMock).not.toHaveBeenCalled();
    expect(agent.instruction).toBe('');
  });

  it('loads @langchain/core once on the first run', async () => {
    const agent = new LangGraphAgent({name: 'weather_agent', graph: GRAPH});

    await collectEvents(agent.runAsync(createContext(agent)));

    expect(loadOptionalPeerMock).toHaveBeenCalledTimes(1);
    expect(loadOptionalPeerMock.mock.calls[0][0]).toEqual({
      packageName: '@langchain/core',
      feature: 'LangGraphAgent',
    });
  });

  it('names the feature and the install command when the peer is missing', async () => {
    const missing = moduleNotFound('@langchain/core');
    loadOptionalPeerMock.mockImplementationOnce((peer) =>
      realLoadOptionalPeer(peer, () => Promise.reject(missing)),
    );
    const agent = new LangGraphAgent({name: 'weather_agent', graph: GRAPH});

    const run = collectEvents(agent.runAsync(createContext(agent)));

    await expect(run).rejects.toThrow(/LangGraphAgent requires/);
    await expect(run).rejects.toThrow(/npm install @langchain\/core/);
  });
});
