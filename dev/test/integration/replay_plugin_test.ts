/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The replay plugin's load / replay / cleanup lifecycle.
 *
 * Ported from adk-python
 * `tests/unittests/cli/plugins/test_replay_plugin.py`, read on `main` at
 * commit a3bd1115. Each `it(...)` keeps the Python test name so a reviewer can
 * grep for the original.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  isReplayConfigError,
  isReplayVerificationError,
  ReplayPlugin,
} from '../../src/integration/replay_plugin.js';
import {
  createCaseDir,
  makeInvocation,
  NON_STREAMING_FILE,
  removeCase,
  SpyTool,
  STREAMING_FILE,
  toolRecordingFixture,
  writeRecordings,
} from './replay_test_support.js';

describe('ReplayPlugin', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await createCaseDir();
  });

  afterEach(async () => {
    await removeCase(caseDir);
  });

  it('test_before_run_without_replay_config_leaves_plugin_inert', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation();
    const tool = new SpyTool();

    const beforeRunResult = await plugin.beforeRunCallback({
      invocationContext,
    });
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
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
      streaming_mode: 'none',
    };
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toBeUndefined();
    expect(tool.liveCalls).toEqual([]);
  });

  it('test_before_tool_returns_recorded_response_not_live_result', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({response: {result: 4}}),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool('roll_die', {result: 'live'});

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({result: 4});
  });

  it('test_before_tool_still_executes_the_underlying_tool', async () => {
    await writeRecordings(caseDir, [toolRecordingFixture({args: {sides: 6}})]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    expect(tool.liveCalls).toEqual([{sides: 6}]);
  });

  it('test_before_run_reads_the_sse_file_in_sse_streaming_mode', async () => {
    await writeRecordings(
      caseDir,
      [toolRecordingFixture({response: {result: 'non-streaming'}})],
      NON_STREAMING_FILE,
    );
    await writeRecordings(
      caseDir,
      [toolRecordingFixture({response: {result: 'streaming'}})],
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
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({result: 'streaming'});
  });

  it('test_before_run_reads_the_plain_file_in_non_streaming_mode', async () => {
    await writeRecordings(
      caseDir,
      [toolRecordingFixture({response: {result: 'non-streaming'}})],
      NON_STREAMING_FILE,
    );
    await writeRecordings(
      caseDir,
      [toolRecordingFixture({response: {result: 'streaming'}})],
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
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({result: 'non-streaming'});
  });

  it('test_before_run_unsupported_streaming_mode_raises_value_error', async () => {
    await writeRecordings(caseDir, [toolRecordingFixture()]);
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({
      caseDir,
      streamingMode: 'bidi',
    });

    const error = await plugin.beforeRunCallback({invocationContext}).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('beforeRunCallback resolved instead of throwing');
    }
    expect(error.message).toContain('Unsupported streaming mode: bidi');
    // Python raises a bare ValueError here, not a ReplayConfigError.
    expect(isReplayConfigError(error)).toBe(false);
  });

  it('test_before_run_missing_recordings_file_raises_config_error', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({caseDir});

    const error = await plugin.beforeRunCallback({invocationContext}).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('beforeRunCallback resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('Recordings file not found');
  });

  it('test_before_run_unparsable_recordings_raise_config_error', async () => {
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      'recordings:\n  - user_message_index: 0\n    agent_name: a\n' +
        '    tool_recordings: {}\n',
      'utf-8',
    );
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({caseDir});

    const error = await plugin.beforeRunCallback({invocationContext}).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('beforeRunCallback resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('Failed to load recordings');
  });

  it('test_before_tool_without_loaded_state_raises_config_error', async () => {
    await writeRecordings(caseDir, [toolRecordingFixture()]);
    const plugin = new ReplayPlugin();
    const {contexts} = makeInvocation({caseDir});

    const error = await plugin
      .beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 6},
        toolContext: contexts['agent_a'],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    if (!(error instanceof Error)) {
      expect.fail('beforeToolCallback resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('Replay state not initialized');
  });

  it('test_before_tool_tool_name_mismatch_raises_verification_error', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({toolName: 'roll_die'}),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});

    await plugin.beforeRunCallback({invocationContext});
    const error = await plugin
      .beforeToolCallback({
        tool: new SpyTool('flip_coin'),
        toolArgs: {sides: 6},
        toolContext: contexts['agent_a'],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    if (!(error instanceof Error)) {
      expect.fail('beforeToolCallback resolved instead of throwing');
    }
    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('Tool name mismatch');
    expect(error.message).toContain('roll_die');
    expect(error.message).toContain('flip_coin');
  });

  it('test_before_tool_args_mismatch_raises_verification_error', async () => {
    await writeRecordings(caseDir, [toolRecordingFixture({args: {sides: 6}})]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});

    await plugin.beforeRunCallback({invocationContext});
    const error = await plugin
      .beforeToolCallback({
        tool: new SpyTool(),
        toolArgs: {sides: 20},
        toolContext: contexts['agent_a'],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    if (!(error instanceof Error)) {
      expect.fail('beforeToolCallback resolved instead of throwing');
    }
    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('Tool args mismatch');
    // The Python test asserts the dict repr `'sides': 20`; the message renders
    // the args with JSON.stringify here.
    expect(error.message).toContain('{"sides":20}');
  });

  it('test_before_tool_beyond_recorded_calls_raises_verification_error', async () => {
    await writeRecordings(caseDir, [toolRecordingFixture()]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    const error = await plugin
      .beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contexts['agent_a'],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    if (!(error instanceof Error)) {
      expect.fail('beforeToolCallback resolved instead of throwing');
    }
    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('more tool requests than expected');
    expect(error.message).toContain('Expected 1');
  });

  it('test_before_tool_advances_a_separate_index_per_agent', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({
        agentName: 'agent_a',
        args: {sides: 6},
        response: {result: 4},
      }),
      toolRecordingFixture({
        agentName: 'agent_b',
        args: {sides: 8},
        response: {result: 7},
      }),
      toolRecordingFixture({
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
      toolContext: contexts['agent_a'],
    });
    const firstB = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 8},
      toolContext: contexts['agent_b'],
    });
    const secondA = await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 20},
      toolContext: contexts['agent_a'],
    });

    expect([firstA, firstB, secondA]).toEqual([
      {result: 4},
      {result: 7},
      {result: 17},
    ]);
  });

  it('test_before_tool_ignores_recordings_for_other_user_messages', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({
        userMessageIndex: 0,
        args: {sides: 6},
        response: {result: 'first turn'},
      }),
      toolRecordingFixture({
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
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({result: 'second turn'});

    // The turn-0 recording is not available to this invocation.
    const error = await plugin
      .beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contexts['agent_a'],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    if (!(error instanceof Error)) {
      expect.fail('beforeToolCallback resolved instead of throwing');
    }
    expect(isReplayVerificationError(error)).toBe(true);
    expect(error.message).toContain('Expected 1');
  });

  it('test_after_run_discards_the_invocation_state', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture(),
      toolRecordingFixture({callId: 'fc-2'}),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    const tool = new SpyTool();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });
    await plugin.afterRunCallback({invocationContext});

    const error = await plugin
      .beforeToolCallback({
        tool,
        toolArgs: {sides: 6},
        toolContext: contexts['agent_a'],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    if (!(error instanceof Error)) {
      expect.fail('beforeToolCallback resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('Replay state not initialized');
  });
});
