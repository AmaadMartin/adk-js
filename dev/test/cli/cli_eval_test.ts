/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, BaseAgent, Event, InvocationContext} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  evalAgent,
  getEvaluationCriteriaOrDefault,
  parseAndGetEvalsToRun,
  printEvalSummary,
  tryGetResetFunc,
} from '../../src/cli/cli_eval.js';
import {
  DEFAULT_CRITERIA,
  EvalResult,
  EvalStatus,
  EvalTurn,
  TOOL_TRAJECTORY_SCORE_KEY,
} from '../../src/evaluation/eval_types.js';
import {processQueryWithRootAgent} from '../../src/evaluation/evaluation_generator.js';
import {AgentFile} from '../../src/utils/agent_loader.js';

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

  it('lets a later selector narrow an eval set listed with none', () => {
    // adk-python extends the same list, so an unselected entry is not sticky.
    expect([...parseAndGetEvalsToRun(['set.json', 'set.json:a'])]).toEqual([
      ['set.json', ['a']],
    ]);
  });

  it('drops a whitespace-only selector', () => {
    expect([...parseAndGetEvalsToRun(['set.json:a, ,b'])]).toEqual([
      ['set.json', ['a', 'b']],
    ]);
  });

  it('keeps a further colon inside the case name, discarding nothing', () => {
    expect([...parseAndGetEvalsToRun(['set.json:a,b:c'])]).toEqual([
      ['set.json', ['a', 'b:c']],
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
  let load: ReturnType<typeof vi.spyOn>;
  let dispose: ReturnType<typeof vi.spyOn>;
  let moduleExports: Record<string, unknown>;

  beforeEach(() => {
    moduleExports = {};
    // `evalAgent` calls `load()`, not `loadAgent()`, so it can keep an
    // exported `App` and hand its plugins to the runner.
    load = vi.spyOn(AgentFile.prototype, 'load').mockResolvedValue(rootAgent);
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

  it('forwards an exported App, so the run keeps its plugins', async () => {
    const evalSetFile = await writePassingEvalSet();
    const app = new App({name: 'my_app', rootAgent});
    load.mockResolvedValue(app);

    await evalAgent({agentPath: 'agent.ts', evalSetFilePaths: [evalSetFile]});

    expect(processQueryWithRootAgent).toHaveBeenCalledWith(
      expect.objectContaining({app, rootAgent: app.rootAgent}),
    );
  });

  it('passes no app when the agent file exports a bare agent', async () => {
    const evalSetFile = await writePassingEvalSet();

    await evalAgent({agentPath: 'agent.ts', evalSetFilePaths: [evalSetFile]});

    expect(processQueryWithRootAgent).toHaveBeenCalledWith(
      expect.objectContaining({app: undefined, rootAgent}),
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

    expect(load).not.toHaveBeenCalled();
  });

  it('disposes the agent file when an eval set file is malformed', async () => {
    const evalSetFile = await writeFile('broken.evalset.json', '[]');

    await expect(
      evalAgent({agentPath: 'agent.ts', evalSetFilePaths: [evalSetFile]}),
    ).rejects.toThrow('No eval data found');

    expect(dispose).toHaveBeenCalled();
  });
});
