/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {runIntegrationTests} from '../../src/integration/run_integration_tests.js';
import {TestRunner} from '../../src/integration/test_runner.js';
import {TestInfo} from '../../src/integration/test_types.js';

vi.mock('../../src/conformance/yaml_agent_loader.js', () => ({
  batchLoadYamlAgentConfig: vi.fn(async () => new Map()),
}));

vi.mock('../../src/conformance/yaml_test_loader.js', () => ({
  batchLoadYamlTestDefs: vi.fn(async () => new Map()),
}));

function testInfo(name: string): TestInfo {
  return {
    name,
    spec: {description: `spec for ${name}`, agent: 'agent'},
    session: {
      id: `session-${name}`,
      appName: 'app',
      userId: 'user',
      state: {},
      events: [],
      lastUpdateTime: 0,
    },
    recordings: {recordings: []},
  };
}

function testDefs(...names: string[]): Map<string, TestInfo> {
  return new Map(names.map((name) => [name, testInfo(name)]));
}

const OPTIONS = {agentsDir: '/agents', testsDir: '/tests', forceRunAll: false};

describe('runIntegrationTests', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 when there are no tests', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs());

    await expect(runIntegrationTests(OPTIONS)).resolves.toBe(0);
  });

  it('returns the number of failed tests', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('a', 'b'));
    vi.spyOn(TestRunner.prototype, 'run').mockRejectedValue(
      new Error('failed'),
    );

    await expect(runIntegrationTests(OPTIONS)).resolves.toBe(2);
  });

  it('does not count passed or skipped tests as failures', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('a', 'b', 'c'));
    vi.spyOn(TestRunner.prototype, 'run')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('failed'));

    await expect(runIntegrationTests(OPTIONS)).resolves.toBe(1);
  });
});
