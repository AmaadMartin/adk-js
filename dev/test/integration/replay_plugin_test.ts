/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmRequest, LlmResponse} from '@google/adk';
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
  recordedLlmResponse,
  ReplayPlugin,
  ReplayVerificationError,
  transferTargetAgentName,
} from '../../src/integration/replay_plugin.js';
import type {Recording} from '../../src/integration/test_types.js';

const TRANSFER_TOOL_NAME = 'transfer_to_agent';

const EMPTY_REQUEST: LlmRequest = {
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
};

const transferTool = new FunctionTool({
  name: TRANSFER_TOOL_NAME,
  description: 'Transfer the question to another agent.',
  execute: () => 'Transfer queued',
});

function createToolContext(agentName: string): Context {
  const agent = new LlmAgent({name: agentName, model: 'gemini-2.0-flash'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent,
      session: createSession({id: 'session-1', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  });
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

function textResponse(text: string, partial?: boolean): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial};
}

function callModel(plugin: ReplayPlugin, agentName: string) {
  return plugin.beforeModelCallback({
    callbackContext: createToolContext(agentName),
    llmRequest: EMPTY_REQUEST,
  });
}

describe('transferTargetAgentName', () => {
  it('reads the argument name recorded by adk-python', () => {
    expect(transferTargetAgentName({agent_name: 'sub_agent'})).toBe(
      'sub_agent',
    );
  });

  it('ignores the argument name declared by adk-js', () => {
    expect(transferTargetAgentName({agentName: 'sub_agent'})).toBeUndefined();
  });

  it('reads the recorded name when both spellings are present', () => {
    expect(
      transferTargetAgentName({agent_name: 'sub_agent', agentName: 'other'}),
    ).toBe('sub_agent');
  });

  it('returns undefined when no agent name is recorded', () => {
    expect(transferTargetAgentName({})).toBeUndefined();
    expect(transferTargetAgentName({agent_name: 42})).toBeUndefined();
  });
});

describe('recordedLlmResponse', () => {
  it('returns the first complete response of llmResponses', () => {
    const response = recordedLlmResponse({
      llmResponses: [
        textResponse('he', true),
        textResponse('hello'),
        textResponse('ignored'),
      ],
    });

    expect(response).toEqual(textResponse('hello'));
  });

  it('returns undefined when every llmResponses entry is partial', () => {
    const response = recordedLlmResponse({
      llmResponses: [textResponse('he', true), textResponse('hell', true)],
    });

    expect(response).toBeUndefined();
  });

  it('falls back to the legacy singular llmResponse', () => {
    const response = recordedLlmResponse({llmResponse: textResponse('hello')});

    expect(response).toEqual(textResponse('hello'));
  });

  it('falls back to the legacy field when llmResponses is empty', () => {
    const response = recordedLlmResponse({
      llmResponses: [],
      llmResponse: textResponse('hello'),
    });

    expect(response).toEqual(textResponse('hello'));
  });

  it('returns undefined for a recording with no LLM pair', () => {
    expect(recordedLlmResponse(undefined)).toBeUndefined();
    expect(recordedLlmResponse({})).toBeUndefined();
  });
});

describe('ReplayPlugin.beforeModelCallback', () => {
  it('replays the complete response of an llmResponses recording', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent-a',
        llmRecording: {
          llmResponses: [textResponse('hel', true), textResponse('hello')],
        },
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});

    await expect(callModel(plugin, 'agent-a')).resolves.toEqual(
      textResponse('hello'),
    );
  });

  it('replays a recording that carries only the legacy llmResponse', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent-a',
        llmRecording: {llmResponse: textResponse('legacy')},
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});

    await expect(callModel(plugin, 'agent-a')).resolves.toEqual(
      textResponse('legacy'),
    );
  });

  it('consumes a recording so the next call does not reuse it', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent-a',
        llmRecording: {llmResponses: [textResponse('once')]},
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});

    await callModel(plugin, 'agent-a');

    await expect(callModel(plugin, 'agent-a')).rejects.toThrow(
      'No LLM recording found for agent agent-a at turn 0',
    );
  });

  it('throws when no recording matches the agent', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent-a',
        llmRecording: {llmResponses: [textResponse('hello')]},
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});

    await expect(callModel(plugin, 'agent-b')).rejects.toThrow(
      'No LLM recording found for agent agent-b at turn 0',
    );
  });

  it('throws when the matching recording holds only partial responses', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent-a',
        llmRecording: {llmResponses: [textResponse('hel', true)]},
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});

    await expect(callModel(plugin, 'agent-a')).rejects.toThrow(
      'No LLM recording found for agent agent-a at turn 0',
    );
  });

  it('throws when the recording belongs to another turn', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 1,
        agentName: 'agent-a',
        llmRecording: {llmResponses: [textResponse('hello')]},
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});

    await expect(callModel(plugin, 'agent-a')).rejects.toThrow(
      'No LLM recording found for agent agent-a at turn 0',
    );
  });
});

describe('ReplayPlugin.beforeToolCallback', () => {
  it('transfers to the agent named in the recorded snake_case arguments', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'root-agent',
        toolRecording: {
          toolCall: {
            name: TRANSFER_TOOL_NAME,
            args: {agent_name: 'sub_agent'},
          },
          toolResponse: {
            name: TRANSFER_TOOL_NAME,
            response: {transfer_state: 'queued'},
          },
        },
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const toolContext = createToolContext('root-agent');

    const response = await plugin.beforeToolCallback({
      tool: transferTool,
      toolArgs: {agent_name: 'sub_agent'},
      toolContext,
    });

    expect(toolContext.actions.transferToAgent).toBe('sub_agent');
    expect(response).toEqual({transfer_state: 'queued'});
  });

  it('throws when no recording matches the tool call', async () => {
    const plugin = new ReplayPlugin([], {userMessageIndex: 0});

    const call = plugin.beforeToolCallback({
      tool: transferTool,
      toolArgs: {agent_name: 'sub_agent'},
      toolContext: createToolContext('root-agent'),
    });

    await expect(call).rejects.toThrow(ReplayVerificationError);
    await expect(call).rejects.toThrow(
      /more tool requests than expected for agent 'root-agent' at user_message_index 0/,
    );
  });

  it('replays the recorded response for a matching call', async () => {
    const plugin = new ReplayPlugin([recording()], {userMessageIndex: 0});

    const replayed = await plugin.beforeToolCallback({
      tool: makeTool('roll_die'),
      toolArgs: {sides: 6},
      toolContext: createToolContext('agent_a'),
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
    const toolContext = createToolContext('agent_a');

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
      toolContext: createToolContext('agent_a'),
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
      toolContext: createToolContext('agent_a'),
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
    const toolContext = createToolContext('agent_a');

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
    const toolContext = createToolContext('agent_a');

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
      /Expected 1, but got request at index 1/,
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
    const contextA = createToolContext('agent_a');
    const contextB = createToolContext('agent_b');

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
    const toolContext = createToolContext('agent_a');

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
    await expect(turnZeroCall).rejects.toThrow(/Expected 1/);
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
      toolContext: createToolContext('agent_a'),
    });

    expect(replayed).toEqual({result: 4});
  });

  it('still applies the transfer_to_agent side effect', async () => {
    const plugin = new ReplayPlugin(
      [
        recording({
          toolName: TRANSFER_TOOL_NAME,
          args: {agent_name: 'agent_b'},
          response: {result: 'transferred'},
        }),
      ],
      {userMessageIndex: 0},
    );
    const toolContext = createToolContext('agent_a');

    const replayed = await plugin.beforeToolCallback({
      tool: makeTool(TRANSFER_TOOL_NAME),
      toolArgs: {agent_name: 'agent_b'},
      toolContext,
    });

    expect(replayed).toEqual({result: 'transferred'});
    expect(toolContext.actions.transferToAgent).toEqual('agent_b');
  });
});
