/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createSession, getLogger} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AgentRegistry} from '../../src/integration/agent_registry.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';
import {TestRunner} from '../../src/integration/test_runner.js';
import {TestInfo} from '../../src/integration/test_types.js';

const MISSING_AGENT = 'missing_agent';

function createTestInfo(name: string): TestInfo {
  return {
    name,
    spec: {description: 'a conformance test', agent: MISSING_AGENT},
    session: createSession({id: 'session-1', appName: 'test-app'}),
    recordings: {recordings: []},
  };
}

function spyOnDebug() {
  return vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
}

describe('TestRunner.run', () => {
  // The skip branch returns before the registry is read, so an empty registry
  // is enough for every case here.
  const testRunner = new TestRunner(
    new AgentRegistry(new IntegrationRegistry()),
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the skip reason at debug level and reports the test as skipped', async () => {
    const loggerSpy = spyOnDebug();

    await expect(
      testRunner.run(createTestInfo('tool/example_tool_001'), false),
    ).resolves.toBe(true);

    expect(loggerSpy).toHaveBeenCalledWith(
      'Skipping test tool/example_tool_001 because: ExampleTool is not implemented yet.',
    );
  });

  it('does not log a skip for a test that is not in the skip list', async () => {
    const loggerSpy = spyOnDebug();

    await expect(
      testRunner.run(createTestInfo('tool/not_skipped_001'), false),
    ).rejects.toThrow(`Agent ${MISSING_AGENT} not found in registry`);

    expect(loggerSpy).not.toHaveBeenCalled();
  });

  it('ignores the skip list when force is set', async () => {
    const loggerSpy = spyOnDebug();

    await expect(
      testRunner.run(createTestInfo('tool/example_tool_001'), true),
    ).rejects.toThrow(`Agent ${MISSING_AGENT} not found in registry`);

    expect(loggerSpy).not.toHaveBeenCalled();
  });
});
