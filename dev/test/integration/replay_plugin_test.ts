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
  RunAsyncToolRequest,
  Session,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {ConformanceRecordingPlugin} from '../../src/integration/conformance_recording_plugin.js';
import {Recording} from '../../src/integration/recordings_schema.js';
import {
  ReplayConfigError,
  ReplayPlugin,
  ReplayVerificationError,
} from '../../src/integration/replay_plugin.js';

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

  const plugin = new ConformanceRecordingPlugin();
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
  it('replays the model turn ConformanceRecordingPlugin recorded', async () => {
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

    // beforeRunCallback builds the invocation's replay state, and
    // beforeToolCallback reads it.
    const invocationContext = makeInvocationContext({});
    await replay.beforeRunCallback({invocationContext});
    const result = await replay.beforeToolCallback({
      tool: rollDie,
      toolArgs: {num_sides: 6},
      toolContext: new Context({invocationContext}),
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

/**
 * Ported from adk-python `main`,
 * `tests/unittests/cli/plugins/test_replay_plugin.py`. Each `it()` string is
 * the Python test name, verbatim.
 */

const NON_STREAMING_FILE = 'generated-recordings.yaml';
const STREAMING_FILE = 'generated-recordings-sse.yaml';

/** Tool that records the args it was actually executed with. */
class SpyTool extends BaseTool {
  readonly liveCalls: Array<Record<string, unknown>> = [];
  private readonly liveResult: Record<string, unknown>;

  constructor(
    options: {name?: string; liveResult?: Record<string, unknown>} = {},
  ) {
    super({name: options.name ?? 'roll_die', description: 'test tool'});
    this.liveResult = options.liveResult ?? {result: 'live'};
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.liveCalls.push(args);
    return this.liveResult;
  }
}

/** One recording, in the snake_case shape the recorder writes to disk. */
function toolCallRecording(
  options: {
    agentName?: string;
    userMessageIndex?: number;
    toolName?: string;
    args?: Record<string, unknown>;
    response?: Record<string, unknown>;
    callId?: string;
  } = {},
): Record<string, unknown> {
  const {
    agentName = 'agent_a',
    userMessageIndex = 0,
    toolName = 'roll_die',
    args = {sides: 6},
    response = {result: 4},
    callId = 'fc-1',
  } = options;
  return {
    user_message_index: userMessageIndex,
    agent_name: agentName,
    tool_recording: {
      tool_call: {id: callId, name: toolName, args},
      tool_response: {id: callId, name: toolName, response},
    },
  };
}

async function writeRecordings(
  caseDir: string,
  recordings: Array<Record<string, unknown>>,
  fileName = NON_STREAMING_FILE,
): Promise<void> {
  await fs.writeFile(
    path.join(caseDir, fileName),
    yaml.dump({recordings}, {sortKeys: false}),
    'utf-8',
  );
}

function invocationContextFor(
  session: Session,
  agentName: string,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: agentName}),
    session,
    pluginManager: new PluginManager([]),
  });
}

/**
 * Builds one invocation plus a per-agent context sharing its session.
 *
 * Every context carries the same invocation id and the same session object,
 * which is what makes a per-agent replay index observable. It stands in for
 * Python's `invocation_context.model_copy(update={'agent': ...})`.
 */
function makeInvocation(
  options: {
    caseDir?: string;
    userMessageIndex?: number;
    streamingMode?: string;
    agentNames?: string[];
  } = {},
): {invocationContext: InvocationContext; contexts: Map<string, Context>} {
  const {
    caseDir,
    userMessageIndex = 0,
    streamingMode = 'none',
    agentNames = ['agent_a'],
  } = options;

  const session = createSession({id: 'test-session', appName: 'test-app'});
  if (caseDir !== undefined) {
    session.state['_adk_replay_config'] = {
      dir: caseDir,
      userMessageIndex,
      streamingMode,
    };
  }

  const contexts = new Map<string, Context>();
  for (const name of agentNames) {
    contexts.set(
      name,
      new Context({invocationContext: invocationContextFor(session, name)}),
    );
  }
  return {
    invocationContext: invocationContextFor(session, agentNames[0]),
    contexts,
  };
}

function contextFor(contexts: Map<string, Context>, name: string): Context {
  const context = contexts.get(name);
  if (!context) {
    expect.fail(`no context was built for agent ${name}`);
  }
  return context;
}

/** Returns the error `call` rejected with, failing the test if it resolved. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (e: unknown) {
    return e;
  }
  return expect.fail('the call resolved instead of rejecting');
}

describe('ReplayPlugin', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-replay-'));
  });

  afterEach(async () => {
    await fs.rm(caseDir, {recursive: true, force: true});
  });

  it('test_before_run_without_replay_config_leaves_plugin_inert', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation();
    const tool = new SpyTool();

    const beforeRunResult = await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    // undefined tells the runtime to execute the tool itself; the plugin
    // neither ran the tool nor consumed a recording.
    expect(beforeRunResult).toBeUndefined();
    expect(replayed).toBeUndefined();
    expect(tool.liveCalls).toEqual([]);
  });

  it('test_before_run_with_partial_replay_config_leaves_plugin_inert', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    invocationContext.session.state['_adk_replay_config'] = {
      dir: caseDir,
      streamingMode: 'none',
    };
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect(replayed).toBeUndefined();
    expect(tool.liveCalls).toEqual([]);
  });

  it('test_before_tool_returns_recorded_response_not_live_result', async () => {
    await writeRecordings(caseDir, [
      toolCallRecording({response: {result: 4}}),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool({liveResult: {result: 'live'}});

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect(replayed).toEqual({result: 4});
  });

  it('test_before_tool_still_executes_the_underlying_tool', async () => {
    await writeRecordings(caseDir, [toolCallRecording({args: {sides: 6}})]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect(tool.liveCalls).toEqual([{sides: 6}]);
  });

  it('test_before_run_reads_the_sse_file_in_sse_streaming_mode', async () => {
    await writeRecordings(
      caseDir,
      [toolCallRecording({response: {result: 'non-streaming'}})],
      NON_STREAMING_FILE,
    );
    await writeRecordings(
      caseDir,
      [toolCallRecording({response: {result: 'streaming'}})],
      STREAMING_FILE,
    );
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      caseDir,
      streamingMode: 'sse',
    });

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect(replayed).toEqual({result: 'streaming'});
  });

  it('test_before_run_reads_the_plain_file_in_non_streaming_mode', async () => {
    await writeRecordings(
      caseDir,
      [toolCallRecording({response: {result: 'non-streaming'}})],
      NON_STREAMING_FILE,
    );
    await writeRecordings(
      caseDir,
      [toolCallRecording({response: {result: 'streaming'}})],
      STREAMING_FILE,
    );
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      caseDir,
      streamingMode: 'none',
    });

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect(replayed).toEqual({result: 'non-streaming'});
  });

  it('test_before_run_unsupported_streaming_mode_raises_value_error', async () => {
    await writeRecordings(caseDir, [toolCallRecording()]);
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({
      caseDir,
      streamingMode: 'bidi',
    });

    // TypeScript has no ValueError; adk-js throws a plain Error with
    // adk-python's message, so it is distinguishable from a config error.
    const error = await rejection(
      plugin.beforeRunCallback({invocationContext}),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ReplayConfigError);
    expect(error).toHaveProperty('message', 'Unsupported streaming mode: bidi');
  });

  it('test_before_run_missing_recordings_file_raises_config_error', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({caseDir});

    const error = await rejection(
      plugin.beforeRunCallback({invocationContext}),
    );

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(error).toHaveProperty(
      'message',
      `Recordings file not found: ${path.join(caseDir, NON_STREAMING_FILE)}`,
    );
  });

  it('test_before_run_unparsable_recordings_raise_config_error', async () => {
    // `tool_recordings` is a typo of `tool_recording`; the strict schema
    // stands in for pydantic's extra="forbid".
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      'recordings:\n  - user_message_index: 0\n    agent_name: a\n' +
        '    tool_recordings: {}\n',
      'utf-8',
    );
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({caseDir});

    const error = await rejection(
      plugin.beforeRunCallback({invocationContext}),
    );

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(String(error)).toContain('Failed to load recordings');
  });

  it('test_before_tool_without_loaded_state_raises_config_error', async () => {
    await writeRecordings(caseDir, [toolCallRecording()]);
    const plugin = new ReplayPlugin();
    const {contexts} = makeInvocation({caseDir});

    const error = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: contextFor(contexts, 'agent_a'),
      }),
    );

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(error).toHaveProperty(
      'message',
      'Replay state not initialized. Ensure beforeRunCallback created it.',
    );
  });

  it('test_before_tool_tool_name_mismatch_raises_verification_error', async () => {
    await writeRecordings(caseDir, [toolCallRecording({toolName: 'roll_die'})]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});

    await plugin.beforeRunCallback({invocationContext});
    const error = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool({name: 'flip_coin'}),
        toolArgs: {sides: 6},
        toolContext: contextFor(contexts, 'agent_a'),
      }),
    );

    expect(error).toBeInstanceOf(ReplayVerificationError);
    expect(error).toHaveProperty(
      'message',
      "Tool name mismatch for agent 'agent_a' at index 0:\n" +
        "recorded: 'roll_die'\ncurrent: 'flip_coin'",
    );
  });

  it('test_before_tool_args_mismatch_raises_verification_error', async () => {
    await writeRecordings(caseDir, [toolCallRecording({args: {sides: 6}})]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});

    await plugin.beforeRunCallback({invocationContext});
    const error = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 20},
        toolContext: contextFor(contexts, 'agent_a'),
      }),
    );

    expect(error).toBeInstanceOf(ReplayVerificationError);
    // adk-python renders a Python dict repr here; adk-js renders JSON.
    expect(error).toHaveProperty(
      'message',
      "Tool args mismatch for agent 'agent_a' at index 0:\n" +
        'recorded: {"sides":6}\ncurrent: {"sides":20}',
    );
  });

  it('test_before_tool_beyond_recorded_calls_raises_verification_error', async () => {
    await writeRecordings(caseDir, [toolCallRecording()]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    const error = await rejection(
      plugin.beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contextFor(contexts, 'agent_a'),
      }),
    );

    expect(error).toBeInstanceOf(ReplayVerificationError);
    expect(error).toHaveProperty(
      'message',
      "Runtime sent more tool requests than expected for agent 'agent_a'" +
        ' at user_message_index 0. Expected 1, but got request at index 1',
    );
  });

  it('test_before_tool_advances_a_separate_index_per_agent', async () => {
    await writeRecordings(caseDir, [
      toolCallRecording({
        agentName: 'agent_a',
        args: {sides: 6},
        response: {result: 4},
      }),
      toolCallRecording({
        agentName: 'agent_b',
        args: {sides: 8},
        response: {result: 7},
      }),
      toolCallRecording({
        agentName: 'agent_a',
        args: {sides: 20},
        response: {result: 17},
      }),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      caseDir,
      agentNames: ['agent_a', 'agent_b'],
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const firstA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });
    const firstB = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 8},
      toolContext: contextFor(contexts, 'agent_b'),
    });
    const secondA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect([firstA, firstB, secondA]).toEqual([
      {result: 4},
      {result: 7},
      {result: 17},
    ]);
  });

  it('test_before_tool_ignores_recordings_for_other_user_messages', async () => {
    await writeRecordings(caseDir, [
      toolCallRecording({
        userMessageIndex: 0,
        args: {sides: 6},
        response: {result: 'first turn'},
      }),
      toolCallRecording({
        userMessageIndex: 1,
        args: {sides: 20},
        response: {result: 'second turn'},
      }),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      caseDir,
      userMessageIndex: 1,
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contextFor(contexts, 'agent_a'),
    });

    expect(replayed).toEqual({result: 'second turn'});
    // The turn-0 recording is not available to this invocation.
    const error = await rejection(
      plugin.beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contextFor(contexts, 'agent_a'),
      }),
    );

    expect(error).toBeInstanceOf(ReplayVerificationError);
    expect(String(error)).toContain('Expected 1');
  });

  it('test_after_run_discards_the_invocation_state', async () => {
    await writeRecordings(caseDir, [
      toolCallRecording(),
      toolCallRecording({callId: 'fc-2'}),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contextFor(contexts, 'agent_a'),
    });
    await plugin.afterRunCallback({invocationContext});

    const error = await rejection(
      plugin.beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contextFor(contexts, 'agent_a'),
      }),
    );

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(String(error)).toContain('Replay state not initialized');
  });
});
