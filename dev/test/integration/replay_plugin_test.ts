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
  transferTargetAgentName,
} from '../../src/integration/replay_plugin.js';
import {Recording} from '../../src/integration/test_types.js';

const TRANSFER_TOOL_NAME = 'transfer_to_agent';

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
