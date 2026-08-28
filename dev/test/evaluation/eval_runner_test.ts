/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, Event, InvocationContext} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runEvals} from '../../src/evaluation/eval_runner.js';
import {
  EVAL_SESSION_ID_PREFIX,
  EvalMetric,
  EvalStatus,
  EvalTurn,
  TOOL_TRAJECTORY_SCORE_KEY,
} from '../../src/evaluation/eval_types.js';
import {processQueryWithRootAgent} from '../../src/evaluation/evaluation_generator.js';
import {AdkLogger} from '../../src/utils/logger.js';

vi.mock('../../src/evaluation/evaluation_generator.js', () => ({
  processQueryWithRootAgent: vi.fn(),
}));

/** A stand-in root agent; every test here stubs the generator. */
class StubAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Never reached: the generator is stubbed.
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Never reached: the generator is stubbed.
  }
}

const TOOL_TRAJECTORY_METRIC: EvalMetric = {
  metricName: TOOL_TRAJECTORY_SCORE_KEY,
  threshold: 1,
};

let tempDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-runner-test-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(tempDir, {recursive: true, force: true});
});

/** Writes `contents` verbatim (so a malformed file can be written too). */
async function writeFile(name: string, contents: string): Promise<string> {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, contents, 'utf-8');
  return filePath;
}

/** Turns the mocked generator returns for the next case. */
function stubGeneratorTurns(...turnLists: EvalTurn[][]): void {
  const mocked = vi.mocked(processQueryWithRootAgent);
  for (const turns of turnLists) {
    mocked.mockResolvedValueOnce(turns);
  }
}

function matchingTurn(): EvalTurn {
  return {
    query: 'roll a die',
    expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
    actual_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
  };
}

function mismatchingTurn(): EvalTurn {
  return {
    query: 'roll a die',
    expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
    actual_tool_use: [],
  };
}

function printedOutput(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('runEvals', () => {
  const rootAgent = new StubAgent({name: 'root_agent'});

  async function writeEvalSet(
    name: string,
    cases: Array<{name: string; data: EvalTurn[]}>,
  ): Promise<string> {
    return writeFile(name, JSON.stringify(cases));
  }

  it('runs every case when no selector is given', async () => {
    const evalSetFile = await writeEvalSet('all.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
      {name: 'case_2', data: [{query: 'b'}]},
    ]);
    stubGeneratorTurns([matchingTurn()], [matchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(results.map((result) => result.evalId)).toEqual([
      'case_1',
      'case_2',
    ]);
  });

  it('runs only the selected cases', async () => {
    const evalSetFile = await writeEvalSet('some.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
      {name: 'case_2', data: [{query: 'b'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, ['case_2']]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(results.map((result) => result.evalId)).toEqual(['case_2']);
  });

  it('yields nothing when the selector names no case in the file', async () => {
    const evalSetFile = await writeEvalSet('none.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, ['case_missing']]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(results).toEqual([]);
  });

  it('passes when the score reaches the threshold exactly', async () => {
    const evalSetFile = await writeEvalSet('boundary.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn(), mismatchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [{metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 0.5}],
    });

    expect(results[0].evalMetricResults[0][1]).toEqual({
      score: 0.5,
      evalStatus: EvalStatus.PASSED,
    });
    expect(results[0].finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails when the score is below the threshold', async () => {
    const evalSetFile = await writeEvalSet('failing.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([mismatchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(results[0].evalMetricResults[0][1]).toEqual({
      score: 0,
      evalStatus: EvalStatus.FAILED,
    });
    expect(results[0].finalEvalStatus).toBe(EvalStatus.FAILED);
    expect(printedOutput()).toContain('Result: ❌ Failed');
  });

  it('records one unevaluated result per unsupported metric', async () => {
    const evalSetFile = await writeEvalSet('unsupported.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [{metricName: 'response_match_score', threshold: 0.8}],
    });

    expect(results[0].evalMetricResults).toEqual([
      [
        {metricName: 'response_match_score', threshold: 0.8},
        {evalStatus: EvalStatus.NOT_EVALUATED},
      ],
    ]);
    expect(results[0].finalEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('warns about an unsupported metric once per run, not once per case', async () => {
    const evalSetFile = await writeEvalSet('warn.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
      {name: 'case_2', data: [{query: 'b'}]},
    ]);
    stubGeneratorTurns([matchingTurn()], [matchingTurn()]);
    const warnSpy = vi.spyOn(AdkLogger.prototype, 'warn');

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [{metricName: 'response_match_score', threshold: 0.8}],
    });

    expect(results).toHaveLength(2);
    expect(warnSpy.mock.calls).toEqual([
      ['`response_match_score` is not supported.'],
    ]);
  });

  it('warns separately about each unsupported metric', async () => {
    const evalSetFile = await writeEvalSet('warn_two.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);
    const warnSpy = vi.spyOn(AdkLogger.prototype, 'warn');

    await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [
        {metricName: 'response_match_score', threshold: 0.8},
        {metricName: 'response_evaluation_score', threshold: 0.8},
      ],
    });

    expect(warnSpy.mock.calls).toEqual([
      ['`response_match_score` is not supported.'],
      ['`response_evaluation_score` is not supported.'],
    ]);
  });

  it('folds a passed and an unevaluated metric to passed', async () => {
    const evalSetFile = await writeEvalSet('mixed.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [
        {metricName: 'response_match_score', threshold: 0.8},
        TOOL_TRAJECTORY_METRIC,
      ],
    });

    expect(results[0].finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('lets a failed metric override an earlier passed one', async () => {
    const evalSetFile = await writeEvalSet('override.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([mismatchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [
        {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 0},
        {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 1},
      ],
    });

    expect(
      results[0].evalMetricResults.map(([, result]) => result.evalStatus),
    ).toEqual([EvalStatus.PASSED, EvalStatus.FAILED]);
    expect(results[0].finalEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('keeps a failure that a later passed metric would otherwise mask', async () => {
    const evalSetFile = await writeEvalSet('shortcircuit.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([mismatchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [
        {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 1},
        {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 0},
      ],
    });

    expect(
      results[0].evalMetricResults.map(([, result]) => result.evalStatus),
    ).toEqual([EvalStatus.FAILED, EvalStatus.PASSED]);
    expect(results[0].finalEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('prefixes the session id', async () => {
    const evalSetFile = await writeEvalSet('session.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(results[0].sessionId.startsWith(EVAL_SESSION_ID_PREFIX)).toBe(true);
    expect(results[0].sessionId.length).toBeGreaterThan(
      EVAL_SESSION_ID_PREFIX.length,
    );
  });

  it('reports a throwing case and still runs the next one', async () => {
    const evalSetFile = await writeEvalSet('throwing.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
      {name: 'case_2', data: [{query: 'b'}]},
    ]);
    vi.mocked(processQueryWithRootAgent).mockRejectedValueOnce(
      new Error('the agent exploded'),
    );
    stubGeneratorTurns([matchingTurn()]);

    const results = await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(printedOutput()).toContain('Error: the agent exploded');
    expect(results.map((result) => result.evalId)).toEqual(['case_2']);
  });

  it('reports a thrown non-Error value', async () => {
    const evalSetFile = await writeEvalSet('nonerror.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    vi.mocked(processQueryWithRootAgent).mockRejectedValueOnce(
      'plain string failure',
    );

    await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(printedOutput()).toContain('Error: plain string failure');
  });

  it('debug-logs the message of an error that carries no stack', async () => {
    const evalSetFile = await writeEvalSet('nostack.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    const stackless = new Error('no stack here');
    stackless.stack = undefined;
    vi.mocked(processQueryWithRootAgent).mockRejectedValueOnce(stackless);
    const debugSpy = vi
      .spyOn(AdkLogger.prototype, 'debug')
      .mockImplementation(() => {});

    await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(debugSpy).toHaveBeenCalledWith('no stack here');
  });

  it('throws and names an empty eval set file', async () => {
    const evalSetFile = await writeEvalSet('empty.evalset.json', []);

    await expect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    ).rejects.toThrow(/No eval data found in eval set file: .*empty\.evalset/);
  });

  it('throws and names an eval set file that is not an array', async () => {
    const evalSetFile = await writeFile(
      'object.evalset.json',
      JSON.stringify({name: 'case_1', data: []}),
    );

    await expect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    ).rejects.toThrow(/Invalid eval set file: .*object\.evalset/);
  });

  it('throws when a case has no name', async () => {
    const evalSetFile = await writeFile(
      'unnamed.evalset.json',
      JSON.stringify([{data: []}]),
    );

    await expect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    ).rejects.toThrow(/Invalid eval set file/);
  });

  it('forwards the initial session and the reset hook to the generator', async () => {
    const evalSetFile = await writeFile(
      'initial.evalset.json',
      JSON.stringify([
        {
          name: 'case_1',
          data: [{query: 'a'}],
          initial_session: {app_name: 'my_app', state: {seen: true}},
        },
      ]),
    );
    stubGeneratorTurns([matchingTurn()]);
    const resetFunc = () => {};

    await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      resetFunc,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    expect(processQueryWithRootAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSession: {app_name: 'my_app', state: {seen: true}},
        resetFunc,
      }),
    );
  });

  it('prints the metric line and the passing verdict', async () => {
    const evalSetFile = await writeEvalSet('printing.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);

    await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [TOOL_TRAJECTORY_METRIC],
    });

    const printed = printedOutput();
    expect(printed).toContain(`Running Eval: ${evalSetFile}:case_1`);
    expect(printed).toContain(
      'Metric: tool_trajectory_avg_score\tStatus: PASSED\tScore: 1\tThreshold: 1',
    );
    expect(printed).toContain('Result: ✅ Passed');
  });

  it('prints N/A as the score of an unevaluated metric', async () => {
    const evalSetFile = await writeEvalSet('na.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn()]);

    await runEvals({
      evalSetToEvals: new Map([[evalSetFile, []]]),
      rootAgent,
      evalMetrics: [{metricName: 'response_match_score', threshold: 0.8}],
    });

    expect(printedOutput()).toContain(
      'Metric: response_match_score\tStatus: NOT_EVALUATED\tScore: N/A\tThreshold: 0.8',
    );
  });
});
