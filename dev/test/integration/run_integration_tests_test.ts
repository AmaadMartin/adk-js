/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {registerConformanceIntegrations} from '../../src/conformance/conformance_integrations.js';
import {batchLoadYamlAgentConfig} from '../../src/conformance/yaml_agent_loader.js';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {
  AgentClass,
  YamlAgentConfig,
} from '../../src/integration/agent_types.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';
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

function agentConfigs(...names: string[]): Map<string, YamlAgentConfig> {
  return new Map(
    names.map((name) => [
      name,
      {
        agentClass: AgentClass.LlmAgent,
        name,
        model: 'test-model',
        description: `${name} agent`,
        instruction: 'answer the question',
        isRootAgent: true,
      },
    ]),
  );
}

const OPTIONS = {agentsDir: '/agents', testsDir: '/tests', forceRunAll: false};

/** The console methods the runner must never reach for. */
const CONSOLE_METHODS = ['log', 'error', 'warn', 'info'] as const;

/** Keeps the runner's records out of the report, and returns the spies. */
function silenceLogger() {
  const logger = getLogger();
  return {
    debug: vi.spyOn(logger, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(logger, 'info').mockImplementation(() => {}),
    error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
  };
}

function silenceConsole() {
  return CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
}

/** The inventory line `IntegrationRegistry.summary()` produces for a real run. */
function conformanceSummary(): string {
  const registry = new IntegrationRegistry();
  registerConformanceIntegrations(registry);
  return registry.summary();
}

describe('runIntegrationTests', () => {
  beforeEach(() => {
    silenceLogger();
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

describe('runIntegrationTests logging', () => {
  let logSpies: ReturnType<typeof silenceLogger>;
  let consoleSpies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    logSpies = silenceLogger();
    consoleSpies = silenceConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Runs one passing, one skipped and one failing test, in that order. */
  function runMixed(): Promise<number> {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(
      testDefs('passing', 'skipped', 'failing'),
    );
    vi.spyOn(TestRunner.prototype, 'run')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('boom'));
    return runIntegrationTests(OPTIONS);
  }

  it('logs the setup narration at debug', async () => {
    vi.mocked(batchLoadYamlAgentConfig).mockResolvedValue(agentConfigs('root'));
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs());

    await runIntegrationTests(OPTIONS);

    expect(logSpies.debug.mock.calls).toEqual([
      ['Loading agents from /agents'],
      [1, 'agents found'],
      ['Registering conformance integrations.'],
      [conformanceSummary()],
      ['Registering agents.'],
      ['1 configs, 0 instantiated agents'],
      ['Loading tests from /tests'],
      [0, 'tests found.'],
      ['Running tests.'],
    ]);
  });

  it('logs the summary block at info', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs());

    await runIntegrationTests(OPTIONS);

    expect(logSpies.info.mock.calls).toEqual([
      ['0 tests passed, 0 tests skipped, 0 tests failed.'],
      ['Successful tests:', ''],
      ['Skipped tests:', ''],
      ['Failed tests:', ''],
    ]);
  });

  it('logs a passing test at debug and names it in the summary', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('a'));
    vi.spyOn(TestRunner.prototype, 'run').mockResolvedValue(false);

    await runIntegrationTests(OPTIONS);

    expect(logSpies.debug).toHaveBeenCalledWith('Running test', 'a');
    expect(logSpies.debug).toHaveBeenCalledWith('Test passed:', 'a');
    expect(logSpies.info).toHaveBeenCalledWith('Successful tests:', 'a');
  });

  it('logs a skipped test at debug and keeps it out of the passed list', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('b'));
    vi.spyOn(TestRunner.prototype, 'run').mockResolvedValue(true);

    await runIntegrationTests(OPTIONS);

    expect(logSpies.debug).toHaveBeenCalledWith('Test skipped:', 'b');
    expect(logSpies.info).toHaveBeenCalledWith('Skipped tests:', 'b');
    expect(logSpies.info).toHaveBeenCalledWith('Successful tests:', '');
  });

  it('logs a failing test at error and runs the rest', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('c', 'd'));
    vi.spyOn(TestRunner.prototype, 'run')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(false);

    await expect(runIntegrationTests(OPTIONS)).resolves.toBe(1);

    expect(logSpies.error).toHaveBeenCalledWith('Test failed:', 'c');
    expect(logSpies.info).toHaveBeenCalledWith('Failed tests:', 'c');
    expect(logSpies.debug).toHaveBeenCalledWith('Test passed:', 'd');
  });

  it('reports the counts of a mixed run on one info line', async () => {
    await runMixed();

    expect(logSpies.info).toHaveBeenCalledWith(
      '1 tests passed, 1 tests skipped, 1 tests failed.',
    );
  });

  it('forwards forceRunAll to the test runner', async () => {
    const defs = testDefs('a');
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(defs);
    const run = vi.spyOn(TestRunner.prototype, 'run').mockResolvedValue(false);

    await runIntegrationTests({...OPTIONS, forceRunAll: true});

    expect(run).toHaveBeenCalledWith(defs.get('a'), true);
  });

  it('writes nothing to the console', async () => {
    await runMixed();

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('leaves colour to the logger and emits no ANSI escapes', async () => {
    await runMixed();

    const logged = [
      ...logSpies.debug.mock.calls,
      ...logSpies.info.mock.calls,
      ...logSpies.error.mock.calls,
    ].flat();

    expect(logged.length).toBeGreaterThan(0);
    for (const message of logged) {
      expect(String(message)).not.toContain('\x1b[');
    }
  });
});
