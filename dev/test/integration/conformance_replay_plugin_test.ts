/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The first suite ports `tests/unittests/cli/plugins/test_replay_plugin.py`
 * from google/adk-python `main`, keeping each Python test name as its title.
 */

import {
  AgentTool,
  BaseAgent,
  BaseTool,
  Context,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ConformanceReplayPlugin,
  isReplayConfigError,
  isReplayVerificationError,
  REPLAY_CONFIG_STATE_KEY,
  ReplayConfig,
} from '../../src/integration/conformance_replay_plugin.js';
import {createTempDir} from '../../src/utils/file_utils.js';

const NON_STREAMING_FILE = 'generated-recordings.yaml';
const STREAMING_FILE = 'generated-recordings-sse.yaml';

/** Tool that records the args it was actually executed with. */
class SpyTool extends BaseTool {
  readonly liveCalls: Array<Record<string, unknown>> = [];

  constructor(
    name = 'roll_die',
    private readonly liveResult: Record<string, unknown> = {result: 'live'},
  ) {
    super({name, description: 'test tool'});
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.liveCalls.push(args);
    return this.liveResult;
  }
}

/** The smallest agent an invocation context accepts. */
class TestAgent extends BaseAgent {
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** A recording in the snake_case shape adk-python writes to disk. */
interface RecordingFixture {
  user_message_index: number;
  agent_name: string;
  tool_recording?: {
    tool_call?: {id?: string; name?: string; args?: Record<string, unknown>};
    tool_response?: {
      id?: string;
      name?: string;
      response?: Record<string, unknown>;
    };
  };
  llm_recording?: {llm_responses?: unknown[]};
}

function recording(
  options: {
    agentName?: string;
    userMessageIndex?: number;
    toolName?: string;
    args?: Record<string, unknown>;
    response?: Record<string, unknown>;
    callId?: string;
  } = {},
): RecordingFixture {
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
  recordings: RecordingFixture[],
  fileName = NON_STREAMING_FILE,
): Promise<void> {
  await fs.writeFile(
    path.join(caseDir, fileName),
    yaml.dump({recordings}, {sortKeys: false}),
    'utf-8',
  );
}

function replayConfig(
  dir: string,
  userMessageIndex = 0,
  streamingMode: 'sse' | 'none' = 'none',
): ReplayConfig {
  return {dir, userMessageIndex, streamingMode};
}

/**
 * Builds one invocation plus a callback context per agent, all sharing the
 * session so that the replay config is visible to every one of them.
 */
function makeInvocation(
  options: {stateConfig?: unknown; agentNames?: string[]} = {},
): {invocationContext: InvocationContext; contexts: Map<string, Context>} {
  const [firstAgent, ...otherAgents] = options.agentNames ?? ['agent_a'];
  const pluginManager = new PluginManager();
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
  });
  if (options.stateConfig !== undefined) {
    session.state[REPLAY_CONFIG_STATE_KEY] = options.stateConfig;
  }
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new TestAgent({name: firstAgent}),
    session,
    pluginManager,
  });
  const contexts = new Map<string, Context>([
    [firstAgent, new Context({invocationContext})],
  ]);
  for (const name of otherAgents) {
    contexts.set(
      name,
      new Context({
        invocationContext: new InvocationContext({
          invocationId: invocationContext.invocationId,
          agent: new TestAgent({name}),
          session,
          pluginManager,
        }),
      }),
    );
  }
  return {invocationContext, contexts};
}

/** Resolves to the error a rejected promise produced, or undefined. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

describe('ConformanceReplayPlugin', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await createTempDir('adk-replay-test');
  });

  afterEach(async () => {
    await fs.rm(caseDir, {recursive: true, force: true});
  });

  it('test_before_run_without_replay_config_leaves_plugin_inert', async () => {
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation();
    const tool = new SpyTool();

    const beforeRunResult = await plugin.beforeRunCallback({
      invocationContext,
    });
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });

    expect(beforeRunResult).toBeUndefined();
    expect(replayed).toBeUndefined();
    expect(tool.liveCalls).toEqual([]);
  });

  it('test_before_run_with_partial_replay_config_leaves_plugin_inert', async () => {
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: {dir: caseDir, streamingMode: 'none'},
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });

    expect(replayed).toBeUndefined();
    expect(tool.liveCalls).toEqual([]);
  });

  it('test_before_tool_returns_recorded_response_not_live_result', async () => {
    await writeRecordings(caseDir, [recording({response: {result: 4}})]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });
    const tool = new SpyTool('roll_die', {result: 'live'});

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });

    expect(replayed).toEqual({result: 4});
  });

  it('test_before_tool_still_executes_the_underlying_tool', async () => {
    await writeRecordings(caseDir, [recording({args: {sides: 6}})]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
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
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir, 0, 'sse'),
    });

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
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
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir, 0, 'none'),
    });

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });

    expect(replayed).toEqual({result: 'non-streaming'});
  });

  it('test_before_run_unsupported_streaming_mode_raises_value_error', async () => {
    await writeRecordings(caseDir, [recording()]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext} = makeInvocation({
      stateConfig: {dir: caseDir, userMessageIndex: 0, streamingMode: 'bidi'},
    });

    const caught = await rejection(
      plugin.beforeRunCallback({invocationContext}),
    );

    // TypeScript has no ValueError; the Python test pins that this one case is
    // not a ReplayConfigError, so assert the negative explicitly.
    expect(errorMessage(caught)).toContain('Unsupported streaming mode: bidi');
    expect(isReplayConfigError(caught)).toBe(false);
  });

  it('test_before_run_missing_recordings_file_raises_config_error', async () => {
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    const caught = await rejection(
      plugin.beforeRunCallback({invocationContext}),
    );

    expect(isReplayConfigError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('Recordings file not found');
  });

  it('test_before_run_unparsable_recordings_raise_config_error', async () => {
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      'recordings:\n  - user_message_index: 0\n    agent_name: a\n' +
        '    tool_recordings: {}\n',
      'utf-8',
    );
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    const caught = await rejection(
      plugin.beforeRunCallback({invocationContext}),
    );

    expect(isReplayConfigError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('Failed to load recordings');
  });

  it('test_before_tool_without_loaded_state_raises_config_error', async () => {
    await writeRecordings(caseDir, [recording()]);
    const plugin = new ConformanceReplayPlugin();
    const {contexts} = makeInvocation({stateConfig: replayConfig(caseDir)});

    const caught = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(isReplayConfigError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('Replay state not initialized');
  });

  it('test_before_tool_tool_name_mismatch_raises_verification_error', async () => {
    await writeRecordings(caseDir, [recording({toolName: 'roll_die'})]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    await plugin.beforeRunCallback({invocationContext});
    const caught = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool('flip_coin'),
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(isReplayVerificationError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('Tool name mismatch');
    expect(errorMessage(caught)).toContain('roll_die');
    expect(errorMessage(caught)).toContain('flip_coin');
  });

  it('test_before_tool_args_mismatch_raises_verification_error', async () => {
    await writeRecordings(caseDir, [recording({args: {sides: 6}})]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    await plugin.beforeRunCallback({invocationContext});
    const caught = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 20},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(isReplayVerificationError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('Tool args mismatch');
    // Python asserts the dict repr `'sides': 20`; TypeScript renders JSON.
    expect(errorMessage(caught)).toContain('{"sides":20}');
  });

  it('test_before_tool_beyond_recorded_calls_raises_verification_error', async () => {
    await writeRecordings(caseDir, [recording()]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });
    const caught = await rejection(
      plugin.beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(isReplayVerificationError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('more tool requests than expected');
    expect(errorMessage(caught)).toContain('Expected 1');
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
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
      agentNames: ['agent_a', 'agent_b'],
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const firstA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });
    const firstB = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 8},
      toolContext: contexts.get('agent_b')!,
    });
    const secondA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contexts.get('agent_a')!,
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
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir, 1),
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contexts.get('agent_a')!,
    });
    const caught = await rejection(
      plugin.beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(replayed).toEqual({result: 'second turn'});
    expect(errorMessage(caught)).toContain('Expected 1');
  });

  it('test_after_run_discards_the_invocation_state', async () => {
    await writeRecordings(caseDir, [recording(), recording({callId: 'fc-2'})]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });
    await plugin.afterRunCallback({invocationContext});
    const caught = await rejection(
      plugin.beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(isReplayConfigError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('Replay state not initialized');
  });
});

describe('ConformanceReplayPlugin, adk-js specifics', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await createTempDir('adk-replay-test');
  });

  afterEach(async () => {
    await fs.rm(caseDir, {recursive: true, force: true});
  });

  it('leaves the plugin inert when the config names no directory', async () => {
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: {userMessageIndex: 0, streamingMode: 'none'},
    });

    await plugin.beforeRunCallback({invocationContext});

    expect(
      await plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    ).toBeUndefined();
  });

  it('leaves the plugin inert when the configured directory is empty', async () => {
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: {dir: '', userMessageIndex: 0, streamingMode: 'none'},
    });

    await plugin.beforeRunCallback({invocationContext});

    expect(
      await plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    ).toBeUndefined();
  });

  it('skips a recording that holds only an LLM exchange', async () => {
    await writeRecordings(caseDir, [
      {
        user_message_index: 0,
        agent_name: 'agent_a',
        llm_recording: {llm_responses: [{content: {role: 'model'}}]},
      },
      recording({response: {result: 4}}),
    ]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts.get('agent_a')!,
    });

    expect(replayed).toEqual({result: 4});
  });

  it('does not run an AgentTool, whose own exchange is not recorded', async () => {
    const subAgent = new LlmAgent({name: 'search_agent', description: 'sub'});
    const agentTool = new AgentTool({agent: subAgent});
    await writeRecordings(caseDir, [
      recording({toolName: 'search_agent', args: {}, response: {result: 4}}),
    ]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: agentTool,
      toolArgs: {},
      toolContext: contexts.get('agent_a')!,
    });

    expect(replayed).toEqual({result: 4});
    expect(invocationContext.session.events).toEqual([]);
  });

  it('rejects a recorded call that carries no response', async () => {
    await writeRecordings(caseDir, [
      {
        user_message_index: 0,
        agent_name: 'agent_a',
        tool_recording: {tool_call: {name: 'roll_die', args: {sides: 6}}},
      },
    ]);
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({
      stateConfig: replayConfig(caseDir),
    });

    await plugin.beforeRunCallback({invocationContext});
    const caught = await rejection(
      plugin.beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: contexts.get('agent_a')!,
      }),
    );

    expect(isReplayConfigError(caught)).toBe(true);
    expect(errorMessage(caught)).toContain('has no response');
  });

  it('discards nothing when an invocation never loaded replay state', async () => {
    const plugin = new ConformanceReplayPlugin();
    const {invocationContext} = makeInvocation();

    await expect(
      plugin.afterRunCallback({invocationContext}),
    ).resolves.toBeUndefined();
  });
});
