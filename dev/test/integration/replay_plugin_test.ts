/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  ReplayPlugin,
  ReplayVerificationError,
} from '../../src/integration/replay_plugin.js';
import {Recording} from '../../src/integration/test_types.js';

function makeToolContext(agentName: string): Context {
  const agent = new LlmAgent({
    name: agentName,
    model: 'test-model',
    description: 'd',
    instruction: 'i',
  });
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

function makeTool(name: string) {
  return new FunctionTool({
    name,
    description: 'test tool',
    execute: async () => ({}),
  });
}

function recording({
  agentName = 'agent_a',
  userMessageIndex = 0,
  toolName = 'roll_die',
  args = {sides: 6} as Record<string, unknown>,
  response = {result: 4} as Record<string, unknown>,
} = {}): Recording {
  return {
    userMessageIndex,
    agentName,
    toolRecording: {
      toolCall: {name: toolName, args},
      toolResponse: {response},
    },
  };
}

describe('ReplayPlugin.beforeToolCallback', () => {
  it('replays the recorded response for a matching call', async () => {
    const plugin = new ReplayPlugin([recording()], {userMessageIndex: 0});

    const replayed = await plugin.beforeToolCallback({
      tool: makeTool('roll_die'),
      toolArgs: {sides: 6},
      toolContext: makeToolContext('agent_a'),
    });

    expect(replayed).toEqual({result: 4});
  });

  it('consumes recordings in recorded order', async () => {
    const plugin = new ReplayPlugin(
      [
        recording({args: {sides: 6}, response: {result: 4}}),
        recording({args: {sides: 20}, response: {result: 17}}),
      ],
      {userMessageIndex: 0},
    );
    const tool = makeTool('roll_die');
    const toolContext = makeToolContext('agent_a');

    const first = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext,
    });
    const second = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext,
    });

    expect([first, second]).toEqual([{result: 4}, {result: 17}]);
  });

  it('rejects on a tool name mismatch', async () => {
    const plugin = new ReplayPlugin([recording({toolName: 'roll_die'})], {
      userMessageIndex: 0,
    });

    const call = plugin.beforeToolCallback({
      tool: makeTool('flip_coin'),
      toolArgs: {sides: 6},
      toolContext: makeToolContext('agent_a'),
    });

    await expect(call).rejects.toThrow(ReplayVerificationError);
    await expect(call).rejects.toThrow(
      /Tool name mismatch for agent 'agent_a' at index 0/,
    );
    await expect(call).rejects.toThrow(/recorded: 'roll_die'/);
    await expect(call).rejects.toThrow(/current: 'flip_coin'/);
  });

  it('rejects on a tool args mismatch', async () => {
    const plugin = new ReplayPlugin([recording({args: {sides: 6}})], {
      userMessageIndex: 0,
    });

    const call = plugin.beforeToolCallback({
      tool: makeTool('roll_die'),
      toolArgs: {sides: 20},
      toolContext: makeToolContext('agent_a'),
    });

    await expect(call).rejects.toThrow(ReplayVerificationError);
    await expect(call).rejects.toThrow(
      /Tool args mismatch for agent 'agent_a' at index 0/,
    );
    await expect(call).rejects.toThrow(/recorded: \{"sides":6\}/);
    await expect(call).rejects.toThrow(/current: \{"sides":20\}/);
  });

  it('rejects when tools are called out of order', async () => {
    const plugin = new ReplayPlugin(
      [
        recording({toolName: 'roll_die', args: {sides: 6}}),
        recording({toolName: 'flip_coin', args: {}}),
      ],
      {userMessageIndex: 0},
    );
    const toolContext = makeToolContext('agent_a');

    const outOfOrder = plugin.beforeToolCallback({
      tool: makeTool('flip_coin'),
      toolArgs: {},
      toolContext,
    });
    await expect(outOfOrder).rejects.toThrow(ReplayVerificationError);
    await expect(outOfOrder).rejects.toThrow(
      /Tool name mismatch for agent 'agent_a' at index 0/,
    );
    await expect(outOfOrder).rejects.toThrow(/recorded: 'roll_die'/);

    // The failed call still consumed the first recording, so the next call is
    // verified against the second one.
    const afterFailure = plugin.beforeToolCallback({
      tool: makeTool('roll_die'),
      toolArgs: {sides: 6},
      toolContext,
    });
    await expect(afterFailure).rejects.toThrow(
      /Tool name mismatch for agent 'agent_a' at index 1/,
    );
    await expect(afterFailure).rejects.toThrow(/recorded: 'flip_coin'/);
  });

  it('rejects when the runtime makes more tool calls than were recorded', async () => {
    const plugin = new ReplayPlugin([recording()], {userMessageIndex: 0});
    const tool = makeTool('roll_die');
    const toolContext = makeToolContext('agent_a');

    await plugin.beforeToolCallback({tool, toolArgs: {sides: 6}, toolContext});

    const extra = plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext,
    });

    await expect(extra).rejects.toThrow(ReplayVerificationError);
    await expect(extra).rejects.toThrow(
      /more tool requests than expected for agent 'agent_a' at user_message_index 0/,
    );
    await expect(extra).rejects.toThrow(
      /called 'roll_die', but only 1 tool recording\(s\) exist/,
    );
  });

  it("tracks each agent's sequence independently", async () => {
    const plugin = new ReplayPlugin(
      [
        recording({
          agentName: 'agent_a',
          args: {sides: 6},
          response: {result: 4},
        }),
        recording({
          agentName: 'agent_b',
          args: {sides: 8},
          response: {result: 7},
        }),
        recording({
          agentName: 'agent_a',
          args: {sides: 20},
          response: {result: 17},
        }),
      ],
      {userMessageIndex: 0},
    );
    const tool = makeTool('roll_die');
    const contextA = makeToolContext('agent_a');
    const contextB = makeToolContext('agent_b');

    const firstA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextA,
    });
    const firstB = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 8},
      toolContext: contextB,
    });
    const secondA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contextA,
    });

    expect([firstA, firstB, secondA]).toEqual([
      {result: 4},
      {result: 7},
      {result: 17},
    ]);
  });

  it('ignores recordings for other user messages', async () => {
    const plugin = new ReplayPlugin(
      [
        recording({
          userMessageIndex: 0,
          args: {sides: 6},
          response: {result: 'first turn'},
        }),
        recording({
          userMessageIndex: 1,
          args: {sides: 20},
          response: {result: 'second turn'},
        }),
      ],
      {userMessageIndex: 1},
    );
    const tool = makeTool('roll_die');
    const toolContext = makeToolContext('agent_a');

    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext,
    });
    expect(replayed).toEqual({result: 'second turn'});

    const turnZeroCall = plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext,
    });
    await expect(turnZeroCall).rejects.toThrow(
      /but only 1 tool recording\(s\) exist/,
    );
  });

  it('matches a recording with no recorded args', async () => {
    const withoutArgs: Recording = {
      userMessageIndex: 0,
      agentName: 'agent_a',
      toolRecording: {
        toolCall: {name: 'roll_die'},
        toolResponse: {response: {result: 4}},
      },
    };
    const plugin = new ReplayPlugin([withoutArgs], {userMessageIndex: 0});

    const replayed = await plugin.beforeToolCallback({
      tool: makeTool('roll_die'),
      toolArgs: {},
      toolContext: makeToolContext('agent_a'),
    });

    expect(replayed).toEqual({result: 4});
  });

  it('still applies the transfer_to_agent side effect', async () => {
    const plugin = new ReplayPlugin(
      [
        recording({
          toolName: 'transfer_to_agent',
          args: {agentName: 'agent_b'},
          response: {result: 'transferred'},
        }),
      ],
      {userMessageIndex: 0},
    );
    const toolContext = makeToolContext('agent_a');

    const replayed = await plugin.beforeToolCallback({
      tool: makeTool('transfer_to_agent'),
      toolArgs: {agentName: 'agent_b'},
      toolContext,
    });

    expect(replayed).toEqual({result: 'transferred'});
    expect(toolContext.actions.transferToAgent).toEqual('agent_b');
  });
});
