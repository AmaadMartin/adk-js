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
import camelcaseKeys from 'camelcase-keys';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {RecordingPlugin} from '../../src/integration/recording_plugin.js';
import {Recordings} from '../../src/integration/test_types.js';

const STATE_NOT_INITIALIZED =
  'Recording state not initialized. Ensure beforeRunCallback created it.';

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Rolls a die.',
  execute: async () => ({result: 4}),
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-recording-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

/** The session state adk-python's conformance recorder writes. */
function recordingsConfig(
  dir: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _adk_recordings_config: {
      dir,
      user_message_index: 0,
      streaming_mode: 'none',
      ...overrides,
    },
  };
}

function makeInvocationContext(options: {
  state: Record<string, unknown>;
  invocationId?: string;
  agentName?: string;
}): InvocationContext {
  return new InvocationContext({
    invocationId: options.invocationId ?? 'inv-1',
    session: createSession({
      id: 'session-1',
      appName: 'conformance',
      userId: 'test-user',
      state: options.state,
    }),
    agent: new LlmAgent({
      name: options.agentName ?? 'dice_agent',
      model: 'fake-model',
    }),
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

async function readFixture(
  dir: string,
  file = 'generated-recordings.yaml',
): Promise<Recordings> {
  const raw = await fs.readFile(path.join(dir, file), 'utf-8');
  return camelcaseKeys(yaml.load(raw) as object, {
    deep: true,
  }) as Recordings;
}

/** Runs one non-streaming model turn end to end. */
async function recordOneTurn(
  plugin: RecordingPlugin,
  invocationContext: InvocationContext,
  text = 'rolled a 4',
): Promise<void> {
  const callbackContext = new Context({invocationContext});
  await plugin.beforeRunCallback({invocationContext});
  await plugin.beforeModelCallback({
    callbackContext,
    llmRequest: llmRequest('roll a die'),
  });
  await plugin.afterModelCallback({
    callbackContext,
    llmResponse: llmResponse(text),
  });
  await plugin.afterRunCallback({invocationContext});
}

describe('RecordingPlugin when recording is off', () => {
  it('stays inert without a recordings config', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({state: {}});
    const callbackContext = new Context({invocationContext});
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-1',
    });

    expect(await plugin.beforeRunCallback({invocationContext})).toBeUndefined();
    expect(
      await plugin.beforeModelCallback({
        callbackContext,
        llmRequest: llmRequest('roll a die'),
      }),
    ).toBeUndefined();
    expect(
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: llmResponse('rolled a 4'),
      }),
    ).toBeUndefined();
    expect(
      await plugin.beforeToolCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
      }),
    ).toBeUndefined();
    expect(
      await plugin.afterToolCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
        result: {result: 4},
      }),
    ).toBeUndefined();
    expect(
      await plugin.onToolErrorCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
        error: new Error('boom'),
      }),
    ).toBeUndefined();
    expect(await plugin.afterRunCallback({invocationContext})).toBeUndefined();

    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it('stays inert when the config names no directory', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {dir: undefined}),
    });

    await recordOneTurn(plugin, invocationContext);

    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it('stays inert when the config names no user message index', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {user_message_index: undefined}),
    });

    await recordOneTurn(plugin, invocationContext);

    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });
});

describe('RecordingPlugin state guards', () => {
  it('rejects a streaming mode that has no fixture', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {streaming_mode: 'bidi'}),
    });

    await expect(plugin.beforeRunCallback({invocationContext})).rejects.toThrow(
      'Unsupported streaming mode: bidi',
    );
  });

  it('rejects a config that names no streaming mode', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {streaming_mode: undefined}),
    });

    await expect(plugin.beforeRunCallback({invocationContext})).rejects.toThrow(
      'Unsupported streaming mode: ',
    );
  });

  it('rejects every callback that runs before beforeRunCallback', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const callbackContext = new Context({invocationContext});
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-1',
    });

    await expect(
      plugin.beforeModelCallback({
        callbackContext,
        llmRequest: llmRequest('roll a die'),
      }),
    ).rejects.toThrow(STATE_NOT_INITIALIZED);
    await expect(
      plugin.afterModelCallback({
        callbackContext,
        llmResponse: llmResponse('rolled a 4'),
      }),
    ).rejects.toThrow(STATE_NOT_INITIALIZED);
    await expect(
      plugin.beforeToolCallback({tool: rollDie, toolArgs: {}, toolContext}),
    ).rejects.toThrow(STATE_NOT_INITIALIZED);
    await expect(
      plugin.afterToolCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
        result: {result: 4},
      }),
    ).rejects.toThrow(STATE_NOT_INITIALIZED);
    await expect(
      plugin.onToolErrorCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
        error: new Error('boom'),
      }),
    ).rejects.toThrow(STATE_NOT_INITIALIZED);
    await expect(plugin.afterRunCallback({invocationContext})).rejects.toThrow(
      STATE_NOT_INITIALIZED,
    );
  });
});

describe('RecordingPlugin recording a run', () => {
  it('writes the request and the response of a non-streaming turn', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {user_message_index: 2}),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(dir);
    expect(recordings).toHaveLength(1);
    expect(recordings[0].userMessageIndex).toBe(2);
    expect(recordings[0].agentName).toBe('dice_agent');
    expect(recordings[0].llmRecording?.llmRequest?.model).toBe('fake-model');
    expect(recordings[0].llmRecording?.llmResponses).toHaveLength(1);
    expect(
      recordings[0].llmRecording?.llmResponses?.[0].content?.parts?.[0].text,
    ).toBe('rolled a 4');
  });

  it('collects a streamed turn into one recording', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {streaming_mode: 'sse'}),
    });
    const callbackContext = new Context({invocationContext});

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: llmRequest('roll a die'),
    });
    for (const chunk of [
      llmResponse('rolled ', true),
      llmResponse('a ', true),
      llmResponse('4'),
    ]) {
      await plugin.afterModelCallback({callbackContext, llmResponse: chunk});
    }
    await plugin.afterRunCallback({invocationContext});

    const {recordings} = await readFixture(
      dir,
      'generated-recordings-sse.yaml',
    );
    expect(recordings).toHaveLength(1);
    expect(recordings[0].llmRecording?.llmResponses).toHaveLength(3);
  });

  it('writes a tool call and its result as one recording', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-1',
    });

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool: rollDie,
      toolArgs: {sides: 6},
      toolContext,
    });
    await plugin.afterToolCallback({
      tool: rollDie,
      toolArgs: {sides: 6},
      toolContext,
      result: {result: 4},
    });
    await plugin.afterRunCallback({invocationContext});

    const {recordings} = await readFixture(dir);
    expect(recordings).toHaveLength(1);
    expect(recordings[0].toolRecording?.toolCall).toEqual({
      id: 'fc-1',
      name: 'roll_die',
      args: {sides: 6},
    });
    expect(recordings[0].toolRecording?.toolResponse).toEqual({
      id: 'fc-1',
      name: 'roll_die',
      response: {result: 4},
    });
  });

  it('keeps the order the callbacks arrived in', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const rootContext = new Context({invocationContext});
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-1',
    });
    const subAgentContext = new Context({
      invocationContext: makeInvocationContext({
        state: invocationContext.session.state,
        agentName: 'summary_agent',
      }),
    });

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext: rootContext,
      llmRequest: llmRequest('roll a die'),
    });
    await plugin.afterModelCallback({
      callbackContext: rootContext,
      llmResponse: llmResponse('calling roll_die'),
    });
    await plugin.beforeToolCallback({
      tool: rollDie,
      toolArgs: {sides: 6},
      toolContext,
    });
    await plugin.afterToolCallback({
      tool: rollDie,
      toolArgs: {sides: 6},
      toolContext,
      result: {result: 4},
    });
    await plugin.beforeModelCallback({
      callbackContext: subAgentContext,
      llmRequest: llmRequest('summarise'),
    });
    await plugin.afterModelCallback({
      callbackContext: subAgentContext,
      llmResponse: llmResponse('rolled a 4'),
    });
    await plugin.afterRunCallback({invocationContext});

    const {recordings} = await readFixture(dir);
    expect(
      recordings.map((r) => [r.agentName, r.toolRecording ? 'tool' : 'llm']),
    ).toEqual([
      ['dice_agent', 'llm'],
      ['dice_agent', 'tool'],
      ['summary_agent', 'llm'],
    ]);
  });

  it('keeps two concurrent invocations apart', async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const plugin = new RecordingPlugin();
    const contextA = makeInvocationContext({
      invocationId: 'inv-a',
      state: recordingsConfig(dirA),
    });
    const contextB = makeInvocationContext({
      invocationId: 'inv-b',
      state: recordingsConfig(dirB, {user_message_index: 1}),
    });
    const callbackA = new Context({invocationContext: contextA});
    const callbackB = new Context({invocationContext: contextB});

    await plugin.beforeRunCallback({invocationContext: contextA});
    await plugin.beforeRunCallback({invocationContext: contextB});
    await plugin.beforeModelCallback({
      callbackContext: callbackA,
      llmRequest: llmRequest('a'),
    });
    await plugin.beforeModelCallback({
      callbackContext: callbackB,
      llmRequest: llmRequest('b'),
    });
    await plugin.afterModelCallback({
      callbackContext: callbackB,
      llmResponse: llmResponse('response b'),
    });
    await plugin.afterModelCallback({
      callbackContext: callbackA,
      llmResponse: llmResponse('response a'),
    });
    await plugin.afterRunCallback({invocationContext: contextA});
    await plugin.afterRunCallback({invocationContext: contextB});

    const fixtureA = await readFixture(dirA);
    const fixtureB = await readFixture(dirB);
    expect(fixtureA.recordings).toHaveLength(1);
    expect(fixtureA.recordings[0].userMessageIndex).toBe(0);
    expect(
      fixtureA.recordings[0].llmRecording?.llmResponses?.[0].content?.parts?.[0]
        .text,
    ).toBe('response a');
    expect(fixtureB.recordings).toHaveLength(1);
    expect(fixtureB.recordings[0].userMessageIndex).toBe(1);
    expect(
      fixtureB.recordings[0].llmRecording?.llmResponses?.[0].content?.parts?.[0]
        .text,
    ).toBe('response b');
  });
});

describe('RecordingPlugin skipping what it cannot record', () => {
  it('records nothing for a tool call that has no functionCallId', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const toolContext = new Context({invocationContext});

    await plugin.beforeRunCallback({invocationContext});
    expect(
      await plugin.beforeToolCallback({
        tool: rollDie,
        toolArgs: {sides: 6},
        toolContext,
      }),
    ).toBeUndefined();
    expect(
      await plugin.afterToolCallback({
        tool: rollDie,
        toolArgs: {sides: 6},
        toolContext,
        result: {result: 4},
      }),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    await expect(readFixture(dir)).resolves.toEqual({recordings: []});
  });

  it('records nothing for a tool result whose call was never opened', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-9',
    });

    await plugin.beforeRunCallback({invocationContext});
    expect(
      await plugin.afterToolCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
        result: {result: 4},
      }),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    await expect(readFixture(dir)).resolves.toEqual({recordings: []});
  });

  it('records nothing for a response whose request was never opened', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const callbackContext = new Context({invocationContext});

    await plugin.beforeRunCallback({invocationContext});
    expect(
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: llmResponse('rolled a 4'),
      }),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    await expect(readFixture(dir)).resolves.toEqual({recordings: []});
  });

  it('drops a recording that never completed', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const callbackContext = new Context({invocationContext});
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-1',
    });

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: llmRequest('roll a die'),
    });
    await plugin.beforeToolCallback({
      tool: rollDie,
      toolArgs: {sides: 6},
      toolContext,
    });
    await plugin.afterRunCallback({invocationContext});

    await expect(readFixture(dir)).resolves.toEqual({recordings: []});
  });

  it('records nothing for a tool error', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });
    const toolContext = new Context({
      invocationContext,
      functionCallId: 'fc-1',
    });

    await plugin.beforeRunCallback({invocationContext});
    expect(
      await plugin.onToolErrorCallback({
        tool: rollDie,
        toolArgs: {},
        toolContext,
        error: new Error('boom'),
      }),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    await expect(readFixture(dir)).resolves.toEqual({recordings: []});
  });
});

describe('RecordingPlugin reading the fixture it appends to', () => {
  it('appends to the recordings already on disk', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'generated-recordings.yaml'),
      'recordings:\n  - user_message_index: 0\n    agent_name: dice_agent\n',
      'utf-8',
    );
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir, {user_message_index: 1}),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(dir);
    expect(recordings.map((r) => r.userMessageIndex)).toEqual([0, 1]);
  });

  it('replaces a fixture that is not valid YAML', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'generated-recordings.yaml'),
      'recordings: [unclosed',
      'utf-8',
    );
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(dir);
    expect(recordings).toHaveLength(1);
  });

  it('replaces a fixture that is not a YAML mapping', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'generated-recordings.yaml'),
      'just a string',
      'utf-8',
    );
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(dir);
    expect(recordings).toHaveLength(1);
  });

  it('treats the empty document adk-python writes as no recordings', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'generated-recordings.yaml'),
      '{}\n',
      'utf-8',
    );
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(dir);
    expect(recordings).toHaveLength(1);
  });

  it('replaces a fixture whose recordings key is not a list', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'generated-recordings.yaml'),
      'recordings:\n',
      'utf-8',
    );
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(dir),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(dir);
    expect(recordings).toHaveLength(1);
  });

  it('keeps the tool keys of a record it appends to', async () => {
    const dir = await makeTempDir();
    const plugin = new RecordingPlugin();

    for (const [invocationId, sides] of [
      ['inv-1', 6],
      ['inv-2', 20],
    ] as const) {
      const invocationContext = makeInvocationContext({
        invocationId,
        state: recordingsConfig(dir, {user_message_index: sides === 6 ? 0 : 1}),
      });
      const toolContext = new Context({
        invocationContext,
        functionCallId: `fc-${sides}`,
      });
      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: rollDie,
        toolArgs: {num_sides: sides},
        toolContext,
      });
      await plugin.afterToolCallback({
        tool: rollDie,
        toolArgs: {num_sides: sides},
        toolContext,
        result: {die_result: 4},
      });
      await plugin.afterRunCallback({invocationContext});
    }

    // Assert on the bytes: the record written by the first invocation must
    // still carry the tool's own key names after the second one appends.
    const raw = await fs.readFile(
      path.join(dir, 'generated-recordings.yaml'),
      'utf-8',
    );
    expect(raw).toContain('num_sides: 6');
    expect(raw).toContain('num_sides: 20');
    expect(raw.match(/die_result: 4/g)).toHaveLength(2);
    expect(raw).not.toContain('numSides');
    expect(raw).not.toContain('dieResult');
  });

  it('records into a test case directory that does not exist yet', async () => {
    const newDir = path.join(await makeTempDir(), 'category', 'new-case');
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(newDir),
    });

    await recordOneTurn(plugin, invocationContext);

    const {recordings} = await readFixture(newDir);
    expect(recordings).toHaveLength(1);
  });

  it('cleans up the invocation state when the write fails', async () => {
    // A file where the case directory should be: `mkdir` cannot create a
    // directory under it, so the write fails.
    const blocked = path.join(await makeTempDir(), 'blocked');
    await fs.writeFile(blocked, 'not a directory', 'utf-8');
    const plugin = new RecordingPlugin();
    const invocationContext = makeInvocationContext({
      state: recordingsConfig(path.join(blocked, 'case')),
    });

    await recordOneTurn(plugin, invocationContext);

    await expect(fs.readFile(blocked, 'utf-8')).resolves.toBe(
      'not a directory',
    );
    await expect(
      plugin.beforeModelCallback({
        callbackContext: new Context({invocationContext}),
        llmRequest: llmRequest('roll a die'),
      }),
    ).rejects.toThrow(STATE_NOT_INITIALIZED);
  });
});
