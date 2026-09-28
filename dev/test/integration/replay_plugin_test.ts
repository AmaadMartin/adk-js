/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  recordedLlmResponse,
  ReplayPlugin,
} from '../../src/integration/replay_plugin.js';
import {Recording} from '../../src/integration/test_types.js';

const EMPTY_REQUEST: LlmRequest = {
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
};

function makeContext(agentName: string): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: agentName}),
      session: createSession({id: 'session-1', appName: 'test-runner'}),
      pluginManager: new PluginManager(),
    }),
  });
}

function textResponse(text: string, partial?: boolean): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial};
}

function callModel(plugin: ReplayPlugin, agentName: string) {
  return plugin.beforeModelCallback({
    callbackContext: makeContext(agentName),
    llmRequest: EMPTY_REQUEST,
  });
}

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
