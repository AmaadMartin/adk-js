/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {RecordingPlugin} from '../../src/integration/recording_plugin.js';

const EMPTY_REQUEST: LlmRequest = {
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
};

function makeContext(agentName: string, functionCallId?: string): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: agentName}),
      session: createSession({id: 'session-1', appName: 'test-recorder'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId,
  });
}

function makeTool(name: string): BaseTool {
  return new FunctionTool({name, description: name, execute: () => ({})});
}

function textResponse(text: string, partial?: boolean): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial};
}

describe('RecordingPlugin model calls', () => {
  it('pairs a model request with its response', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 2});
    const callbackContext = makeContext('agent-a');
    const llmRequest: LlmRequest = {...EMPTY_REQUEST, model: 'gemini-3-pro'};

    await plugin.beforeModelCallback({callbackContext, llmRequest});
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('hello'),
    });

    expect(plugin.recordings).toEqual([
      {
        userMessageIndex: 2,
        agentName: 'agent-a',
        llmRecording: {llmRequest, llmResponses: [textResponse('hello')]},
      },
    ]);
  });

  it('collects every partial response of one model call', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});
    const callbackContext = makeContext('agent-a');

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_REQUEST,
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('he', true),
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('hello', true),
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('hello'),
    });

    expect(plugin.recordings[0].llmRecording?.llmResponses).toEqual([
      textResponse('he', true),
      textResponse('hello', true),
      textResponse('hello'),
    ]);
  });

  it('closes the model call on the first response that is not partial', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});
    const callbackContext = makeContext('agent-a');

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_REQUEST,
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('hello'),
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('late'),
    });

    expect(plugin.recordings[0].llmRecording?.llmResponses).toEqual([
      textResponse('hello'),
    ]);
  });

  it('drops a model call that never got a response', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});

    await plugin.beforeModelCallback({
      callbackContext: makeContext('agent-a'),
      llmRequest: EMPTY_REQUEST,
    });

    expect(plugin.recordings).toEqual([]);
  });

  it('ignores a response for an agent that has no open model call', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});

    await plugin.afterModelCallback({
      callbackContext: makeContext('agent-a'),
      llmResponse: textResponse('orphan'),
    });

    expect(plugin.recordings).toEqual([]);
  });
});

describe('RecordingPlugin tool calls', () => {
  it('pairs a tool call with its result by function call id', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 1});
    const toolContext = makeContext('agent-a', 'fc-1');
    const tool = makeTool('roll_die');
    const toolArgs = {sides: 6};

    await plugin.beforeToolCallback({tool, toolArgs, toolContext});
    await plugin.afterToolCallback({
      tool,
      toolArgs,
      toolContext,
      result: {value: 4},
    });

    expect(plugin.recordings).toEqual([
      {
        userMessageIndex: 1,
        agentName: 'agent-a',
        toolRecording: {
          toolCall: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
          toolResponse: {id: 'fc-1', name: 'roll_die', response: {value: 4}},
        },
      },
    ]);
  });

  it('drops a tool call that never returned a result', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});
    const tool = makeTool('roll_die');

    await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext: makeContext('agent-a', 'fc-1'),
    });

    expect(plugin.recordings).toEqual([]);
  });

  it('records nothing for a tool call with no function call id', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});
    const tool = makeTool('roll_die');
    const toolContext = makeContext('agent-a');

    await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext});
    await plugin.afterToolCallback({
      tool,
      toolArgs: {},
      toolContext,
      result: {value: 4},
    });

    expect(plugin.recordings).toEqual([]);
  });

  it('ignores a result whose function call id has no open tool call', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});
    const tool = makeTool('roll_die');

    await plugin.afterToolCallback({
      tool,
      toolArgs: {},
      toolContext: makeContext('agent-a', 'fc-unknown'),
      result: {value: 4},
    });

    expect(plugin.recordings).toEqual([]);
  });
});

describe('RecordingPlugin ordering', () => {
  it('keeps the order the calls started when two agents interleave', async () => {
    const plugin = new RecordingPlugin({userMessageIndex: 0});
    const rootContext = makeContext('root-agent');
    const subContext = makeContext('sub-agent');
    const toolContext = makeContext('sub-agent', 'fc-1');
    const tool = makeTool('roll_die');

    await plugin.beforeModelCallback({
      callbackContext: rootContext,
      llmRequest: EMPTY_REQUEST,
    });
    await plugin.beforeModelCallback({
      callbackContext: subContext,
      llmRequest: EMPTY_REQUEST,
    });
    await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext});
    // The calls complete in the reverse of the order they started.
    await plugin.afterToolCallback({
      tool,
      toolArgs: {},
      toolContext,
      result: {value: 4},
    });
    await plugin.afterModelCallback({
      callbackContext: subContext,
      llmResponse: textResponse('sub'),
    });
    await plugin.afterModelCallback({
      callbackContext: rootContext,
      llmResponse: textResponse('root'),
    });

    expect(
      plugin.recordings.map((recording) => [
        recording.agentName,
        recording.toolRecording ? 'tool' : 'model',
      ]),
    ).toEqual([
      ['root-agent', 'model'],
      ['sub-agent', 'model'],
      ['sub-agent', 'tool'],
    ]);
  });

  it('accumulates recordings across user messages', async () => {
    const context = {userMessageIndex: 0};
    const plugin = new RecordingPlugin(context);
    const callbackContext = makeContext('agent-a');

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_REQUEST,
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('first'),
    });

    context.userMessageIndex = 1;
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: EMPTY_REQUEST,
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: textResponse('second'),
    });

    expect(
      plugin.recordings.map((recording) => recording.userMessageIndex),
    ).toEqual([0, 1]);
  });
});
