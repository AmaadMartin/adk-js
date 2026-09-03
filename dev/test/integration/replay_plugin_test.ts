/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/cli/plugins/test_replay_plugin.py`. Each `it()` string is
 * the Python test name, verbatim.
 */

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
  Session,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ReplayConfigError,
  ReplayPlugin,
  ReplayVerificationError,
} from '../../src/integration/replay_plugin.js';

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
function recording(
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
    await writeRecordings(caseDir, [recording({response: {result: 4}})]);
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
    await writeRecordings(caseDir, [recording({args: {sides: 6}})]);
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
      [recording({response: {result: 'non-streaming'}})],
      NON_STREAMING_FILE,
    );
    await writeRecordings(
      caseDir,
      [recording({response: {result: 'streaming'}})],
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
      [recording({response: {result: 'non-streaming'}})],
      NON_STREAMING_FILE,
    );
    await writeRecordings(
      caseDir,
      [recording({response: {result: 'streaming'}})],
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
    await writeRecordings(caseDir, [recording()]);
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
    await writeRecordings(caseDir, [recording()]);
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
    await writeRecordings(caseDir, [recording({toolName: 'roll_die'})]);
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
    await writeRecordings(caseDir, [recording({args: {sides: 6}})]);
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
    await writeRecordings(caseDir, [recording()]);
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
    await writeRecordings(caseDir, [recording(), recording({callId: 'fc-2'})]);
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
