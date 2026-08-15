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

    await expect(
      plugin.beforeToolCallback({
        tool: transferTool,
        toolArgs: {agent_name: 'sub_agent'},
        toolContext: createToolContext('root-agent'),
      }),
    ).rejects.toThrow(
      'No tool recording found for agent root-agent, tool transfer_to_agent at turn 0',
    );
  });
});
