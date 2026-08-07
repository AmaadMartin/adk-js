/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {batchLoadYamlTestDefs} from '../../src/conformance/yaml_test_loader.js';
import {runIntegrationTests} from '../../src/integration/run_integration_tests.js';
import {TestRunner} from '../../src/integration/test_runner.js';
import {TestInfo} from '../../src/integration/test_types.js';

vi.mock('../../src/conformance/yaml_agent_loader.js', () => ({
  batchLoadYamlAgentConfig: vi.fn(async () => new Map()),
}));

vi.mock('../../src/conformance/yaml_test_loader.js', () => ({
  batchLoadYamlTestDefs: vi.fn(),
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

/** Produces the AssertionError `assert.deepStrictEqual` throws on a mismatch. */
function assertionError(): Error {
  try {
    assert.deepStrictEqual(
      [{author: 'agent', content: {parts: [{text: 'actual text'}]}}],
      [{author: 'agent', content: {parts: [{text: 'expected text'}]}}],
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
  }
  return expect.fail('deepStrictEqual did not throw with an Error');
}

const spyOnLog = () => vi.spyOn(console, 'log');
const spyOnError = () => vi.spyOn(console, 'error');
const spyOnRun = () => vi.spyOn(TestRunner.prototype, 'run');

describe('runIntegrationTests', () => {
  let logSpy: ReturnType<typeof spyOnLog>;
  let errorSpy: ReturnType<typeof spyOnError>;
  let run: ReturnType<typeof spyOnRun>;

  const errorOutput = () =>
    errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
  const logOutput = () =>
    logSpy.mock.calls.map((args) => args.join(' ')).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = spyOnLog().mockImplementation(() => {});
    errorSpy = spyOnError().mockImplementation(() => {});
    run = spyOnRun();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runAll = () =>
    runIntegrationTests({
      agentsDir: 'agents',
      testsDir: 'tests',
      forceRunAll: false,
    });

  it('prints the assertion diff of a failing test', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('core/multi'));
    run.mockRejectedValue(assertionError());

    await runAll();

    expect(errorOutput()).toContain('Test failed: core/multi');
    expect(errorOutput()).toContain('actual text');
    expect(errorOutput()).toContain('expected text');
  });

  it('repeats every failure in the summary', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(
      testDefs('alpha', 'beta'),
    );
    run.mockRejectedValueOnce(new Error('alpha broke'));
    run.mockRejectedValueOnce(new Error('beta broke'));

    await runAll();

    expect(logSpy).toHaveBeenCalledWith('Failed tests:', 'alpha, beta');
    expect(errorOutput()).toContain('FAILED alpha');
    expect(errorOutput()).toContain('FAILED beta');
    expect(errorOutput()).toContain('alpha broke');
    expect(errorOutput()).toContain('beta broke');
  });

  it('prints the message of a plain Error', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('tool/tool'));
    run.mockRejectedValue(new Error('Agent x not found in registry'));

    await runAll();

    expect(errorOutput()).toContain('Agent x not found in registry');
  });

  it('reports a thrown value that is not an Error', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('tool/tool'));
    run.mockRejectedValue('boom');

    await runAll();

    expect(errorOutput()).toContain('Test failed: tool/tool');
    expect(errorOutput()).toContain('boom');
  });

  it('does not report passing or skipped tests as failures', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(
      testDefs('passing', 'skipped'),
    );
    run.mockResolvedValueOnce(false);
    run.mockResolvedValueOnce(true);

    await runAll();

    expect(logOutput()).toContain(
      '1 tests passed, 1 tests skipped, 0 tests failed.',
    );
    expect(logSpy).toHaveBeenCalledWith('Successful tests:', 'passing');
    expect(errorOutput()).not.toContain('FAILED');
  });

  it('indents a multi-line message in the summary', async () => {
    vi.mocked(batchLoadYamlTestDefs).mockResolvedValue(testDefs('multiline'));
    run.mockRejectedValue(new Error('first line\nsecond line'));

    await runAll();

    expect(errorOutput()).toContain('FAILED multiline');
    expect(errorOutput()).toContain('\n  second line');
  });
});
