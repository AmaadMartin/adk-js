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
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {Recording} from '../../src/integration/recordings_schema.js';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';

const AGENT_NAME = 'dice_agent';

function callbackContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'conformance'}),
      pluginManager: new PluginManager(),
      agent: new LlmAgent({name: AGENT_NAME}),
    }),
  });
}

const LLM_REQUEST: LlmRequest = {
  model: 'fake-model',
  contents: [{role: 'user', parts: [{text: 'roll a die'}]}],
  liveConnectConfig: {},
  toolsDict: {},
};

function replay(recordings: Recording[]) {
  const plugin = new ReplayPlugin(recordings, {userMessageIndex: 0});
  return plugin.beforeModelCallback({
    callbackContext: callbackContext(),
    llmRequest: LLM_REQUEST,
  });
}

function recording(llmRecording: Recording['llmRecording']): Recording {
  return {userMessageIndex: 0, agentName: AGENT_NAME, llmRecording};
}

describe('ReplayPlugin.beforeModelCallback', () => {
  it('replays the adk-js singular llmResponse', async () => {
    const response = await replay([
      recording({
        llmResponse: {content: {role: 'model', parts: [{text: 'rolled a 4'}]}},
      }),
    ]);

    expect(response?.content?.parts?.[0]?.text).toBe('rolled a 4');
  });

  it('replays a single-entry adk-python llmResponses list', async () => {
    const response = await replay([
      recording({
        llmResponses: [
          {content: {role: 'model', parts: [{text: 'rolled a 4'}]}},
        ],
      }),
    ]);

    expect(response?.content?.parts?.[0]?.text).toBe('rolled a 4');
  });

  it('prefers the singular llmResponse when both are recorded', async () => {
    const response = await replay([
      recording({
        llmResponse: {content: {role: 'model', parts: [{text: 'singular'}]}},
        llmResponses: [{content: {role: 'model', parts: [{text: 'listed'}]}}],
      }),
    ]);

    expect(response?.content?.parts?.[0]?.text).toBe('singular');
  });

  it('refuses a multi-entry llmResponses list it cannot serve', async () => {
    await expect(
      replay([
        recording({
          llmResponses: [
            {content: {role: 'model', parts: [{text: 'first'}]}},
            {content: {role: 'model', parts: [{text: 'second'}]}},
          ],
        }),
      ]),
    ).rejects.toThrow('Cannot replay a recording holding 2 llmResponses');
  });

  it('skips a recording that holds no response at all', async () => {
    await expect(
      replay([recording({llmResponses: []}), recording(undefined)]),
    ).rejects.toThrow(`No LLM recording found for agent ${AGENT_NAME}`);
  });
});
