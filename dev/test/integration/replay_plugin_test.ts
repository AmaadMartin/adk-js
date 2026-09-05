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
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {RecordingPlugin} from '../../src/integration/recording_plugin.js';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';

const SPEC_YAML = `
description: rolls a die
agent: dice_agent
`;

const SESSION_YAML = `
app_name: conformance
user_id: test-user
id: session-1
events: []
`;

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Rolls a die.',
  execute: async () => ({die_result: 4}),
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

function makeInvocationContext(state: Record<string, unknown>) {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({
      id: 'session-1',
      appName: 'conformance',
      userId: 'test-user',
      state,
    }),
    agent: new LlmAgent({name: 'dice_agent', model: 'fake-model'}),
    pluginManager: new PluginManager(),
  });
}

function llmRequest(text: string): LlmRequest {
  return {
    model: 'fake-model',
    contents: [{role: 'user', parts: [{text}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

function llmResponse(text: string, partial?: boolean): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial};
}

/** Writes a complete conformance test case, recorded by the plugin itself. */
async function recordTestCase(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-round-trip-'));
  tempDirs.push(root);
  const caseDir = path.join(root, 'dice');
  await fs.mkdir(caseDir, {recursive: true});
  await fs.writeFile(path.join(caseDir, 'spec.yaml'), SPEC_YAML, 'utf-8');
  await fs.writeFile(
    path.join(caseDir, 'generated-session.yaml'),
    SESSION_YAML,
    'utf-8',
  );

  const plugin = new RecordingPlugin();
  const invocationContext = makeInvocationContext({
    _adk_recordings_config: {
      dir: caseDir,
      user_message_index: 0,
      streaming_mode: 'sse',
    },
  });
  const callbackContext = new Context({invocationContext});
  const toolContext = new Context({invocationContext, functionCallId: 'fc-1'});

  await plugin.beforeRunCallback({invocationContext});
  await plugin.beforeModelCallback({
    callbackContext,
    llmRequest: llmRequest('roll a die'),
  });
  await plugin.afterModelCallback({
    callbackContext,
    llmResponse: llmResponse('rolling', true),
  });
  await plugin.afterModelCallback({
    callbackContext,
    llmResponse: llmResponse('rolled a 4'),
  });
  await plugin.beforeToolCallback({
    tool: rollDie,
    toolArgs: {num_sides: 6},
    toolContext,
  });
  await plugin.afterToolCallback({
    tool: rollDie,
    toolArgs: {num_sides: 6},
    toolContext,
    result: {die_result: 4},
  });
  await plugin.afterRunCallback({invocationContext});

  // The loader reads the non-streaming name, so give it the file it expects.
  await fs.rename(
    path.join(caseDir, 'generated-recordings-sse.yaml'),
    path.join(caseDir, 'generated-recordings.yaml'),
  );
  return root;
}

describe('recording and replaying one test case', () => {
  it('replays the model turn RecordingPlugin recorded', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await recordTestCase();

    const tests = await batchLoadYamlTestDefs(root);
    const testInfo = tests.get('dice');
    if (!testInfo) {
      expect.fail('the loader did not find the recorded test case');
    }
    const replay = new ReplayPlugin(testInfo.recordings.recordings, {
      userMessageIndex: 0,
    });

    const response = await replay.beforeModelCallback({
      callbackContext: new Context({
        invocationContext: makeInvocationContext({}),
      }),
      llmRequest: llmRequest('roll a die'),
    });

    // The last entry of a streamed turn is its result; the partials precede it.
    expect(response?.content?.parts?.[0].text).toBe('rolled a 4');
  });

  it('replays the tool result with the keys the tool chose', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await recordTestCase();

    const tests = await batchLoadYamlTestDefs(root);
    const testInfo = tests.get('dice');
    if (!testInfo) {
      expect.fail('the loader did not find the recorded test case');
    }
    const replay = new ReplayPlugin(testInfo.recordings.recordings, {
      userMessageIndex: 0,
    });

    const result = await replay.beforeToolCallback({
      tool: rollDie,
      toolArgs: {num_sides: 6},
      toolContext: new Context({
        invocationContext: makeInvocationContext({}),
      }),
    });

    expect(result).toEqual({die_result: 4});
    expect(
      testInfo.recordings.recordings[1].toolRecording?.toolCall?.args,
    ).toEqual({num_sides: 6});
  });

  it('refuses to replay an LLM recording that holds no response', async () => {
    const replay = new ReplayPlugin(
      [
        {
          userMessageIndex: 0,
          agentName: 'dice_agent',
          llmRecording: {llmResponses: []},
        },
      ],
      {userMessageIndex: 0},
    );

    await expect(
      replay.beforeModelCallback({
        callbackContext: new Context({
          invocationContext: makeInvocationContext({}),
        }),
        llmRequest: llmRequest('roll a die'),
      }),
    ).rejects.toThrow('No LLM recording found for agent dice_agent at turn 0');
  });
});
