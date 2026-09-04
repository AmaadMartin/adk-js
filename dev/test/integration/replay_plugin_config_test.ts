/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How the plugin reads `_adk_replay_config` out of session state. adk-python
 * writes snake_case keys and nothing camelCases a state delta on the way in,
 * so both spellings have to work.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';
import {
  createCaseDir,
  makeInvocation,
  removeCase,
  SpyTool,
  toolRecordingFixture,
  writeRecordings,
} from './replay_test_support.js';

describe('ReplayPlugin session-state config', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await createCaseDir();
  });

  afterEach(async () => {
    await removeCase(caseDir);
  });

  it('reads the camelCase spelling of both multi-word keys', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({userMessageIndex: 1, response: {result: 4}}),
    ]);
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    invocationContext.session.state['_adk_replay_config'] = {
      dir: caseDir,
      userMessageIndex: 1,
      streamingMode: 'none',
    };

    await plugin.beforeRunCallback({invocationContext});
    const replayed = await plugin.beforeToolCallback({
      tool: new SpyTool(),
      toolArgs: {sides: 6},
      toolContext: contexts['agent_a'],
    });

    expect(replayed).toEqual({result: 4});
  });

  it('stays inert when the config names an empty directory', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext, contexts} = makeInvocation({caseDir});
    invocationContext.session.state['_adk_replay_config'] = {
      dir: '',
      user_message_index: 0,
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

  it('reports a streaming mode it cannot map to a file', async () => {
    const plugin = new ReplayPlugin();
    const {invocationContext} = makeInvocation({caseDir});
    invocationContext.session.state['_adk_replay_config'] = {
      dir: caseDir,
      user_message_index: 0,
    };

    await expect(plugin.beforeRunCallback({invocationContext})).rejects.toThrow(
      'Unsupported streaming mode: undefined',
    );
  });
});
