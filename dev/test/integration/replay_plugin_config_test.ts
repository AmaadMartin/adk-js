/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How the plugin reads `_adk_replay_config` out of session state.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';
import {
  createCaseDir,
  makeInvocation,
  removeCase,
  SpyTool,
} from './replay_test_support.js';

describe('ReplayPlugin session-state config', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await createCaseDir();
  });

  afterEach(async () => {
    await removeCase(caseDir);
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
