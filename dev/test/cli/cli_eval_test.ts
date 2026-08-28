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
import {
  DEFAULT_CRITERIA,
  EVAL_SESSION_ID_PREFIX,
  evalAgent,
  EvalMetric,
  EvalResult,
  EvalStatus,
  getEvaluationCriteriaOrDefault,
  parseAndGetEvalsToRun,
  printEvalSummary,
  runEvals,
  TOOL_TRAJECTORY_SCORE_KEY,
  tryGetResetFunc,
} from '../../src/cli/cli_eval.js';
import {EvalTurn} from '../../src/evaluation/evaluation_constants.js';
import {processQueryWithRootAgent} from '../../src/evaluation/evaluation_generator.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {AdkLogger} from '../../src/utils/logger.js';

vi.mock('../../src/evaluation/evaluation_generator.js', () => ({
  processQueryWithRootAgent: vi.fn(),
}));

/** A stand-in root agent; every test that needs one stubs the generator. */
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-eval-test-'));
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

async function collect(
  generator: AsyncGenerator<EvalResult>,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for await (const result of generator) {
    results.push(result);
  }
  return results;
}

function printedOutput(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('parseAndGetEvalsToRun', () => {
  // Ported from adk-python's tests/unittests/cli/utils/test_cli_eval.py.
  it.each([
    [
      'windows-backslash-path-without-selectors',
      String.raw`C:\tmp\agent\eval.evalset.json`,
      [[String.raw`C:\tmp\agent\eval.evalset.json`, []]],
    ],
    [
      'windows-backslash-path-with-one-selector',
      String.raw`C:\tmp\agent\eval.evalset.json:case1`,
      [[String.raw`C:\tmp\agent\eval.evalset.json`, ['case1']]],
    ],
    [
      'windows-backslash-path-with-multiple-selectors',
      String.raw`C:\tmp\agent\eval.evalset.json:case1,case2`,
      [[String.raw`C:\tmp\agent\eval.evalset.json`, ['case1', 'case2']]],
    ],
    [
      'windows-forward-slash-path',
      'C:/tmp/agent/eval.evalset.json:case1',
      [['C:/tmp/agent/eval.evalset.json', ['case1']]],
    ],
    [
      'lowercase-windows-drive',
      String.raw`d:\tmp\agent\eval.evalset.json:case1`,
      [[String.raw`d:\tmp\agent\eval.evalset.json`, ['case1']]],
    ],
    [
      'posix-path-with-selectors',
      '/tmp/agent/eval.evalset.json:case1,case2',
      [['/tmp/agent/eval.evalset.json', ['case1', 'case2']]],
    ],
    [
      'eval-set-id-with-selectors',
      'my_eval_set:case1,case2',
      [['my_eval_set', ['case1', 'case2']]],
    ],
    ['eval-set-id-without-selectors', 'my_eval_set', [['my_eval_set', []]]],
    [
      'posix-path-without-selectors',
      '/tmp/agent/eval.evalset.json',
      [['/tmp/agent/eval.evalset.json', []]],
    ],
  ])('parses %s', (_id, input, expected) => {
    expect([...parseAndGetEvalsToRun([input])]).toEqual(expected);
  });

  it('preserves a windows drive on a path that does not exist', () => {
    expect([
      ...parseAndGetEvalsToRun([String.raw`C:\missing\evals.json`]),
    ]).toEqual([[String.raw`C:\missing\evals.json`, []]]);
  });

  it('splits the case selector to the right of the drive letter', () => {
    expect([
      ...parseAndGetEvalsToRun([String.raw`C:\evals\set.json:case1,case2`]),
    ]).toEqual([[String.raw`C:\evals\set.json`, ['case1', 'case2']]]);
  });

  it('accumulates the selectors of an eval set listed twice', () => {
    expect([...parseAndGetEvalsToRun(['set.json:a', 'set.json:b,c'])]).toEqual([
      ['set.json', ['a', 'b', 'c']],
    ]);
  });

  it('drops a whitespace-only selector', () => {
    expect([...parseAndGetEvalsToRun(['set.json:a, ,b'])]).toEqual([
      ['set.json', ['a', 'b']],
    ]);
  });

  it('cuts the selector list at a further colon', () => {
    expect([...parseAndGetEvalsToRun(['set.json:a,b:c'])]).toEqual([
      ['set.json', ['a', 'b']],
    ]);
  });

  it('keeps a case named like an object prototype key', () => {
    const parsed = parseAndGetEvalsToRun(['set.json:__proto__']);

    expect(parsed.get('set.json')).toEqual(['__proto__']);
  });

  it('keeps the eval sets in the order they were given', () => {
    expect([...parseAndGetEvalsToRun(['b.json', 'a.json']).keys()]).toEqual([
      'b.json',
      'a.json',
    ]);
  });
});

describe('getEvaluationCriteriaOrDefault', () => {
  it('returns the default criteria when no path is supplied', async () => {
    await expect(getEvaluationCriteriaOrDefault()).resolves.toEqual({
      tool_trajectory_avg_score: 1.0,
      response_match_score: 0.8,
    });
  });

  it('returns the criteria the file declares', async () => {
    const configPath = await writeFile(
      'test_config.json',
      JSON.stringify({criteria: {tool_trajectory_avg_score: 0.5}}),
    );

    await expect(getEvaluationCriteriaOrDefault(configPath)).resolves.toEqual({
      tool_trajectory_avg_score: 0.5,
    });
  });

  it('throws when the file has no criteria object', async () => {
    const configPath = await writeFile(
      'no_criteria.json',
      JSON.stringify({tool_trajectory_avg_score: 1}),
    );

    await expect(getEvaluationCriteriaOrDefault(configPath)).rejects.toThrow(
      /Invalid format for .*no_criteria\.json/,
    );
  });

  it('throws when criteria is an array', async () => {
    const configPath = await writeFile(
      'array_criteria.json',
      JSON.stringify({criteria: ['tool_trajectory_avg_score']}),
    );

    await expect(getEvaluationCriteriaOrDefault(configPath)).rejects.toThrow(
      /Invalid format for/,
    );
  });

  it('throws when a threshold is not a number', async () => {
    const configPath = await writeFile(
      'string_threshold.json',
      JSON.stringify({criteria: {tool_trajectory_avg_score: 'high'}}),
    );

    await expect(getEvaluationCriteriaOrDefault(configPath)).rejects.toThrow(
      /Invalid format for/,
    );
  });

  it('throws when a threshold is not finite', async () => {
    // JSON has no Infinity literal, so this is how a config file expresses it.
    const configPath = await writeFile(
      'infinite_threshold.json',
      '{"criteria": {"tool_trajectory_avg_score": 1e400}}',
    );

    await expect(getEvaluationCriteriaOrDefault(configPath)).rejects.toThrow(
      /Invalid format for/,
    );
  });

  it('throws and names a path that does not exist', async () => {
    const missingPath = path.join(tempDir, 'missing.json');

    await expect(getEvaluationCriteriaOrDefault(missingPath)).rejects.toThrow(
      /missing\.json/,
    );
  });
});

describe('tryGetResetFunc', () => {
  /** An AgentFile whose module namespace is fixed for the test. */
  function agentFileExporting(
    moduleExports: Record<string, unknown> | undefined,
  ): AgentFile {
    const agentFile = new AgentFile('agent.ts');
    Object.defineProperty(agentFile, 'moduleExports', {
      get: () => moduleExports,
    });
    return agentFile;
  }

  it('returns the exported resetData function', () => {
    const resetData = () => {};

    expect(tryGetResetFunc(agentFileExporting({resetData}))).toBe(resetData);
  });

  it('returns undefined when the module exports no resetData', () => {
    expect(tryGetResetFunc(agentFileExporting({}))).toBeUndefined();
  });

  it('returns undefined when resetData is not a function', () => {
    expect(
      tryGetResetFunc(agentFileExporting({resetData: 'nope'})),
    ).toBeUndefined();
  });

  it('returns undefined before the agent file is loaded', () => {
    expect(tryGetResetFunc(agentFileExporting(undefined))).toBeUndefined();
  });
});

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, ['case_2']]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

    expect(results.map((result) => result.evalId)).toEqual(['case_2']);
  });

  it('yields nothing when the selector names no case in the file', async () => {
    const evalSetFile = await writeEvalSet('none.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, ['case_missing']]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

    expect(results).toEqual([]);
  });

  it('passes when the score reaches the threshold exactly', async () => {
    const evalSetFile = await writeEvalSet('boundary.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([matchingTurn(), mismatchingTurn()]);

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [{metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 0.5}],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [{metricName: 'response_match_score', threshold: 0.8}],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [{metricName: 'response_match_score', threshold: 0.8}],
      }),
    );

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

    await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [
          {metricName: 'response_match_score', threshold: 0.8},
          {metricName: 'response_evaluation_score', threshold: 0.8},
        ],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [
          {metricName: 'response_match_score', threshold: 0.8},
          TOOL_TRAJECTORY_METRIC,
        ],
      }),
    );

    expect(results[0].finalEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('lets a failed metric override an earlier passed one', async () => {
    const evalSetFile = await writeEvalSet('override.evalset.json', [
      {name: 'case_1', data: [{query: 'a'}]},
    ]);
    stubGeneratorTurns([mismatchingTurn()]);

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [
          {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 0},
          {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 1},
        ],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [
          {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 1},
          {metricName: TOOL_TRAJECTORY_SCORE_KEY, threshold: 0},
        ],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    const results = await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

    expect(debugSpy).toHaveBeenCalledWith('no stack here');
  });

  it('throws and names an empty eval set file', async () => {
    const evalSetFile = await writeEvalSet('empty.evalset.json', []);

    await expect(
      collect(
        runEvals({
          evalSetToEvals: new Map([[evalSetFile, []]]),
          rootAgent,
          evalMetrics: [TOOL_TRAJECTORY_METRIC],
        }),
      ),
    ).rejects.toThrow(/No eval data found in eval set file: .*empty\.evalset/);
  });

  it('throws and names an eval set file that is not an array', async () => {
    const evalSetFile = await writeFile(
      'object.evalset.json',
      JSON.stringify({name: 'case_1', data: []}),
    );

    await expect(
      collect(
        runEvals({
          evalSetToEvals: new Map([[evalSetFile, []]]),
          rootAgent,
          evalMetrics: [TOOL_TRAJECTORY_METRIC],
        }),
      ),
    ).rejects.toThrow(/Invalid eval set file: .*object\.evalset/);
  });

  it('throws when a case has no name', async () => {
    const evalSetFile = await writeFile(
      'unnamed.evalset.json',
      JSON.stringify([{data: []}]),
    );

    await expect(
      collect(
        runEvals({
          evalSetToEvals: new Map([[evalSetFile, []]]),
          rootAgent,
          evalMetrics: [TOOL_TRAJECTORY_METRIC],
        }),
      ),
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

    await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        resetFunc,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [TOOL_TRAJECTORY_METRIC],
      }),
    );

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

    await collect(
      runEvals({
        evalSetToEvals: new Map([[evalSetFile, []]]),
        rootAgent,
        evalMetrics: [{metricName: 'response_match_score', threshold: 0.8}],
      }),
    );

    expect(printedOutput()).toContain(
      'Metric: response_match_score\tStatus: NOT_EVALUATED\tScore: N/A\tThreshold: 0.8',
    );
  });
});

describe('printEvalSummary', () => {
  function resultFor(
    evalSetFile: string,
    evalId: string,
    finalEvalStatus: EvalStatus,
  ): EvalResult {
    return {
      evalSetFile,
      evalId,
      finalEvalStatus,
      evalMetricResults: [],
      sessionId: 'session',
    };
  }

  it('counts passes and failures per eval set file', () => {
    printEvalSummary([
      resultFor('a.json', 'case_1', EvalStatus.PASSED),
      resultFor('a.json', 'case_2', EvalStatus.FAILED),
      resultFor('b.json', 'case_1', EvalStatus.PASSED),
    ]);

    const printed = printedOutput();
    expect(printed).toContain('Eval Run Summary');
    expect(printed).toContain('a.json:\n  Tests passed: 1\n  Tests failed: 1');
    expect(printed).toContain('b.json:\n  Tests passed: 1\n  Tests failed: 0');
  });

  it('counts an unevaluated case as a failure, as adk-python does', () => {
    printEvalSummary([resultFor('a.json', 'case_1', EvalStatus.NOT_EVALUATED)]);

    expect(printedOutput()).toContain(
      'a.json:\n  Tests passed: 0\n  Tests failed: 1',
    );
  });

  it('prints the header even with no results', () => {
    printEvalSummary([]);

    expect(printedOutput()).toContain('Eval Run Summary');
  });
});

describe('DEFAULT_CRITERIA', () => {
  it('matches the thresholds adk-python falls back to', () => {
    expect(DEFAULT_CRITERIA).toEqual({
      tool_trajectory_avg_score: 1.0,
      response_match_score: 0.8,
    });
  });
});

describe('evalAgent', () => {
  const rootAgent = new StubAgent({name: 'root_agent'});
  let loadAgent: ReturnType<typeof vi.spyOn>;
  let dispose: ReturnType<typeof vi.spyOn>;
  let moduleExports: Record<string, unknown>;

  beforeEach(() => {
    moduleExports = {};
    loadAgent = vi
      .spyOn(AgentFile.prototype, 'loadAgent')
      .mockResolvedValue(rootAgent);
    dispose = vi
      .spyOn(AgentFile.prototype, 'dispose')
      .mockResolvedValue(undefined);
    vi.spyOn(AgentFile.prototype, 'moduleExports', 'get').mockImplementation(
      () => moduleExports,
    );
  });

  /** An eval set of one case whose recorded trajectory matches. */
  async function writePassingEvalSet(): Promise<string> {
    stubGeneratorTurns([matchingTurn()]);
    return writeFile(
      'agent.evalset.json',
      JSON.stringify([{name: 'case_1', data: [{query: 'roll a die'}]}]),
    );
  }

  it('prints the criteria, the verdict and the summary', async () => {
    const evalSetFile = await writePassingEvalSet();
    const configFilePath = await writeFile(
      'test_config.json',
      JSON.stringify({criteria: {[TOOL_TRAJECTORY_SCORE_KEY]: 1}}),
    );

    await evalAgent({
      agentPath: 'agent.ts',
      evalSetFilePaths: [evalSetFile],
      configFilePath,
    });

    const printed = printedOutput();
    expect(printed).toContain(
      'Using evaluation criteria: {"tool_trajectory_avg_score":1}',
    );
    expect(printed).toContain('Result: ✅ Passed');
    expect(printed).toContain(
      `${evalSetFile}:\n  Tests passed: 1\n  Tests failed: 0`,
    );
  });

  it('falls back to the default criteria with no config file', async () => {
    const evalSetFile = await writePassingEvalSet();

    await evalAgent({agentPath: 'agent.ts', evalSetFilePaths: [evalSetFile]});

    expect(printedOutput()).toContain(
      `Using evaluation criteria: ${JSON.stringify(DEFAULT_CRITERIA)}`,
    );
  });

  it('forwards the agent file resetData hook to the run', async () => {
    const evalSetFile = await writePassingEvalSet();
    const resetData = vi.fn();
    moduleExports = {resetData};

    await evalAgent({agentPath: 'agent.ts', evalSetFilePaths: [evalSetFile]});

    expect(processQueryWithRootAgent).toHaveBeenCalledWith(
      expect.objectContaining({resetFunc: resetData, rootAgent}),
    );
  });

  it('disposes the agent file when a criteria file is malformed', async () => {
    const evalSetFile = await writePassingEvalSet();
    const configFilePath = await writeFile('bad_config.json', '{}');

    await expect(
      evalAgent({
        agentPath: 'agent.ts',
        evalSetFilePaths: [evalSetFile],
        configFilePath,
      }),
    ).rejects.toThrow('Invalid format for');

    expect(loadAgent).not.toHaveBeenCalled();
  });

  it('disposes the agent file when an eval set file is malformed', async () => {
    const evalSetFile = await writeFile('broken.evalset.json', '[]');

    await expect(
      evalAgent({agentPath: 'agent.ts', evalSetFilePaths: [evalSetFile]}),
    ).rejects.toThrow('No eval data found');

    expect(dispose).toHaveBeenCalled();
  });
});
