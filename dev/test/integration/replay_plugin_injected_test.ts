/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The constructor-injected replay mode, which `TestRunner` uses. It has no
 * session-state config, so the plugin replays from the recordings it was
 * handed and from the user message index its caller advances.
 */

import {
  AgentTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';
import {Recording} from '../../src/integration/test_types.js';
import {makeInvocation, SpyTool} from './replay_test_support.js';

const EMPTY_LLM_REQUEST: LlmRequest = {
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
};

function toolRecording(options: {
  agentName?: string;
  userMessageIndex?: number;
  toolName?: string;
  args?: Record<string, unknown>;
  response?: Record<string, unknown>;
}): Recording {
  const {
    agentName = 'agent_a',
    userMessageIndex = 0,
    toolName = 'roll_die',
    args = {sides: 6},
    response = {result: 4},
  } = options;
  return {
    userMessageIndex,
    agentName,
    toolRecording: {
      toolCall: {id: 'fc-1', name: toolName, args},
      toolResponse: {id: 'fc-1', name: toolName, response},
    },
  };
}

describe('ReplayPlugin injected mode', () => {
  it('replays a recorded response and advances the index', async () => {
    const recordings: Recording[] = [
      toolRecording({args: {sides: 6}, response: {result: 4}}),
      toolRecording({args: {sides: 20}, response: {result: 17}}),
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const {contexts} = makeInvocation();
    const tool = new SpyTool();

    const first = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });
    const second = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contexts['agent_a'],
    });

    expect([first, second]).toEqual([{result: 4}, {result: 17}]);
    expect(tool.liveCalls).toEqual([{sides: 6}, {sides: 20}]);
  });

  it('restarts the index when the caller moves to the next user message', async () => {
    const recordings: Recording[] = [
      toolRecording({userMessageIndex: 0, response: {result: 'turn 0'}}),
      toolRecording({userMessageIndex: 1, response: {result: 'turn 1'}}),
    ];
    const context = {userMessageIndex: 0};
    const plugin = new ReplayPlugin(recordings, context);
    const {contexts} = makeInvocation();

    const turn0 = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });
    context.userMessageIndex = 1;
    const turn1 = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    expect([turn0, turn1]).toEqual([{result: 'turn 0'}, {result: 'turn 1'}]);
  });

  it('replays an empty response when the recording has none', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent_a',
        toolRecording: {toolCall: {name: 'roll_die', args: {sides: 6}}},
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const {contexts} = makeInvocation();

    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({});
  });

  it('sets the transfer target from a recorded transfer_to_agent call', async () => {
    const recordings: Recording[] = [
      toolRecording({
        toolName: 'transfer_to_agent',
        args: {agentName: 'agent_b'},
        response: {},
      }),
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const {contexts} = makeInvocation();
    const toolContext = contexts['agent_a'];

    await plugin.beforeToolCallback({
      tool: new SpyTool('transfer_to_agent'),
      toolArgs: {agentName: 'agent_b'},
      toolContext,
    });

    expect(toolContext.actions.transferToAgent).toBe('agent_b');
  });

  it('leaves the transfer target unset when the recorded name is not a string', async () => {
    const recordings: Recording[] = [
      toolRecording({
        toolName: 'transfer_to_agent',
        args: {agentName: 7},
        response: {},
      }),
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const {contexts} = makeInvocation();
    const toolContext = contexts['agent_a'];

    await plugin.beforeToolCallback({
      tool: new SpyTool('transfer_to_agent'),
      toolArgs: {agentName: 7},
      toolContext,
    });

    expect(toolContext.actions.transferToAgent).toBeUndefined();
  });

  it('verifies and replays an AgentTool without running it', async () => {
    const agentTool = new AgentTool({agent: new LlmAgent({name: 'sub_agent'})});
    const recordings: Recording[] = [
      toolRecording({
        toolName: 'sub_agent',
        args: {request: 'hello'},
        response: {result: 'recorded'},
      }),
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const {contexts} = makeInvocation();

    // Running this AgentTool would need a Runner and a model, so a resolved
    // replay proves the plugin never reaches that path.
    const replayed = await plugin.beforeToolCallback({
      tool: agentTool,
      toolArgs: {request: 'hello'},
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({result: 'recorded'});
  });

  it('uses an empty agent name for a context with no agent', async () => {
    const recordings: Recording[] = [toolRecording({agentName: ''})];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'agentless-invocation',
        session: createSession({
          id: 'agentless-session',
          appName: 'replay-test',
        }),
        pluginManager: new PluginManager([]),
      }),
    });

    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext,
    });

    expect(replayed).toEqual({result: 4});
  });

  it('replays a recorded LLM response', async () => {
    const recordings: Recording[] = [
      {
        userMessageIndex: 0,
        agentName: 'agent_a',
        llmRecording: {
          llmResponse: {
            content: {role: 'model', parts: [{text: 'recorded answer'}]},
          },
        },
      },
    ];
    const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
    const {contexts} = makeInvocation();

    const replayed = await plugin.beforeModelCallback({
      callbackContext: contexts['agent_a'],
      llmRequest: EMPTY_LLM_REQUEST,
    });

    expect(replayed?.content?.parts?.[0]?.text).toBe('recorded answer');
  });

  it('fails when no LLM recording is left for the agent', async () => {
    const plugin = new ReplayPlugin([], {userMessageIndex: 0});
    const {contexts} = makeInvocation();

    await expect(
      plugin.beforeModelCallback({
        callbackContext: contexts['agent_a'],
        llmRequest: EMPTY_LLM_REQUEST,
      }),
    ).rejects.toThrow('No LLM recording found for agent agent_a at turn 0');
  });

  it('stays inert for the model when no recordings were injected', async () => {
    const plugin = new ReplayPlugin();
    const {contexts} = makeInvocation();

    const replayed = await plugin.beforeModelCallback({
      callbackContext: contexts['agent_a'],
      llmRequest: EMPTY_LLM_REQUEST,
    });

    expect(replayed).toBeUndefined();
  });

  it('discards nothing when afterRun runs without loaded state', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation();

    await expect(
      plugin.afterRunCallback({invocationContext}),
    ).resolves.toBeUndefined();
  });
});
