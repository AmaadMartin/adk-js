/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEvaluator,
  BaseEvalService,
  CreateEvalServiceOptions,
  EvalCaseResult,
  EvalMetricResult,
  EvalSet,
  EvalStatus,
  EvaluateRequest,
  InferenceRequest,
  InferenceStatus,
  InMemoryArtifactService,
  InputValidationError,
  Invocation,
  PrebuiltMetrics,
} from '@google/adk';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {StubEvalSetResultsManager} from './stub_eval_set_results_manager.js';

const {createEvalService} = vi.hoisted(() => ({createEvalService: vi.fn()}));

vi.mock('../../src/evaluation/eval_runtime.js', () => ({
  loadEvalRuntime: async () => ({createEvalService}),
}));

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const AGENT_MODULE = join(FIXTURES, 'root_agent_module.ts');
const APP_MODULE = join(FIXTURES, 'app_module.ts');
const METRIC = PrebuiltMetrics.RESPONSE_MATCH_SCORE;
const THRESHOLD = 0.8;

/** What the fake eval service was asked to do. */
interface RuntimeSpy {
  serviceOptions: CreateEvalServiceOptions[];
  inferenceRequests: InferenceRequest[];
  evaluateRequests: EvaluateRequest[];
}

function makeInvocation(prompt: string, response: string): Invocation {
  return {
    invocationId: `inv-${prompt}`,
    userContent: {parts: [{text: prompt}], role: 'user'},
    finalResponse: {parts: [{text: response}], role: 'model'},
    intermediateData: {
      toolUses: [{name: 'roll_die', args: {sides: 6}}],
      toolResponses: [],
      intermediateResponses: [],
    },
    creationTimestamp: 0,
  };
}

function makeMetricResult(score: number): EvalMetricResult {
  return {
    metricName: METRIC,
    threshold: THRESHOLD,
    criterion: {threshold: THRESHOLD},
    score,
    evalStatus: score >= THRESHOLD ? EvalStatus.PASSED : EvalStatus.FAILED,
  };
}

function makeCaseResult(evalId: string, score: number): EvalCaseResult {
  return {
    evalSetId: 'dice',
    evalId,
    finalEvalStatus: score >= THRESHOLD ? EvalStatus.PASSED : EvalStatus.FAILED,
    evalMetricResultPerInvocation: [
      {
        actualInvocation: makeInvocation('Roll a die', 'I rolled a 4.'),
        expectedInvocation: makeInvocation('Roll a die', 'I rolled a 4.'),
        evalMetricResults: [makeMetricResult(score)],
      },
    ],
  };
}

/** An eval case result for a run whose inference crashed. */
function makeCrashedCaseResult(evalId: string): EvalCaseResult {
  return {
    evalSetId: 'dice',
    evalId,
    finalEvalStatus: EvalStatus.FAILED,
    evalMetricResultPerInvocation: [],
  };
}

const EVAL_SET: EvalSet = {
  evalSetId: 'dice',
  evalCases: [
    {
      evalId: 'roll_die',
      conversation: [makeInvocation('Roll a die', 'I rolled a 4.')],
      creationTimestamp: 0,
    },
  ],
  creationTimestamp: 0,
};

const EVAL_CONFIG = {criteria: {[METRIC]: THRESHOLD}};

/** Points the mocked runtime at a service that yields `results`. */
function installRuntime(results: EvalCaseResult[]): RuntimeSpy {
  const spy: RuntimeSpy = {
    serviceOptions: [],
    inferenceRequests: [],
    evaluateRequests: [],
  };
  createEvalService.mockImplementation(
    (options: CreateEvalServiceOptions): BaseEvalService => {
      spy.serviceOptions.push(options);
      return {
        async *performInference(request: InferenceRequest) {
          spy.inferenceRequests.push(request);
          yield {
            appName: request.appName,
            evalSetId: request.evalSetId,
            evalCaseId: 'roll_die',
            status: InferenceStatus.SUCCESS,
          };
        },
        async *evaluate(request: EvaluateRequest) {
          spy.evaluateRequests.push(request);
          yield* results;
        },
      };
    },
  );
  return spy;
}

async function makeWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'adk-agent-evaluator-'));
}

beforeEach(() => {
  createEvalService.mockReset();
  vi.restoreAllMocks();
});

describe('AgentEvaluator.evaluateEvalSet wiring', () => {
  it.each([
    ['a live model config', {timeoutSeconds: 45}, true, 45],
    ['no live model config', undefined, false, undefined],
  ])(
    'forwards %s to the inference config',
    async (_name, liveModelConfig, useLive, liveTimeoutSeconds) => {
      const spy = installRuntime([makeCaseResult('roll_die', 1)]);

      await AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: {...EVAL_CONFIG, liveModelConfig},
        printDetailedResults: false,
      });

      expect(spy.inferenceRequests[0].inferenceConfig).toEqual({
        useLive,
        ...(liveTimeoutSeconds === undefined ? {} : {liveTimeoutSeconds}),
      });
    },
  );

  it('forwards the artifact service and the app name', async () => {
    const artifactService = new InMemoryArtifactService();
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      artifactService,
      appName: 'dice_app',
      printDetailedResults: false,
    });

    expect(spy.serviceOptions[0].artifactService).toBe(artifactService);
    expect(spy.inferenceRequests[0].appName).toBe('dice_app');
  });

  it('defaults the app name when no results manager needs a real one', async () => {
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: false,
    });

    expect(spy.inferenceRequests[0].appName).toBe('test_app');
  });

  it('forwards the app that the agent module exports', async () => {
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: APP_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: false,
    });

    expect(spy.serviceOptions[0].app?.name).toBe('dice_app');
    expect(spy.serviceOptions[0].rootAgent.name).toBe('dice_agent');
  });

  it('forwards no app when the agent module exports none', async () => {
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: false,
    });

    expect(spy.serviceOptions[0].app).toBeUndefined();
  });

  it('forwards the eval config, so the runtime can fork its registry', async () => {
    const evalConfig = {
      ...EVAL_CONFIG,
      customMetrics: {[METRIC]: {codeConfig: {name: './metrics.js#score'}}},
      userSimulatorConfig: {type: 'llm_backed'},
    };
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig,
      printDetailedResults: false,
    });

    expect(spy.serviceOptions[0].evalConfig).toBe(evalConfig);
    expect(spy.evaluateRequests[0].evaluateConfig.evalMetrics).toEqual([
      {
        metricName: METRIC,
        threshold: THRESHOLD,
        criterion: {threshold: THRESHOLD},
        customFunctionPath: './metrics.js#score',
      },
    ]);
  });

  it('runs the eval set once per requested run', async () => {
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      numRuns: 3,
      printDetailedResults: false,
    });

    expect(spy.inferenceRequests).toHaveLength(3);
  });

  it('runs the eval set twice by default', async () => {
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: false,
    });

    expect(spy.inferenceRequests).toHaveLength(2);
  });

  it('hands the eval set to the service through an eval sets manager', async () => {
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: false,
    });

    const manager = spy.serviceOptions[0].evalSetsManager;
    const stored = await manager.getEvalSet('test_app', 'dice');
    expect(stored?.evalCases.map((evalCase) => evalCase.evalId)).toEqual([
      'roll_die',
    ]);
  });
});

describe('AgentEvaluator.evaluateEvalSet verdicts', () => {
  it('passes when the averaged score reaches the threshold', async () => {
    installRuntime([
      makeCaseResult('roll_die', 0.7),
      makeCaseResult('roll_die', 0.9),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        printDetailedResults: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails when the averaged score is below the threshold', async () => {
    installRuntime([
      makeCaseResult('roll_die', 0.7),
      makeCaseResult('roll_die', 0.5),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      `${METRIC} for ${AGENT_MODULE} Failed. Expected 0.8, but got 0.6.`,
    );
  });

  it('tells the caller how to see more detail', async () => {
    installRuntime([makeCaseResult('roll_die', 0.1)]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      /re-run this test with `printDetailedResults` set to `true`/,
    );
  });

  it('leaves the hint out when the detail was already printed', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    installRuntime([makeCaseResult('roll_die', 0.1)]);

    const error = await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
    }).catch((err: unknown) => err);

    expect(String(error)).not.toContain('re-run this test');
  });

  it('reports a run that produced no metric result at all', async () => {
    installRuntime([
      makeCrashedCaseResult('roll_die'),
      makeCrashedCaseResult('roll_die'),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      `roll_die for ${AGENT_MODULE} Failed. 2 of 2 runs were recorded as ` +
        'failed without producing any metric results.',
    );
  });

  it('reports a metric that was never scored as not evaluated', async () => {
    const unscored = makeCaseResult('roll_die', 1);
    unscored.evalMetricResultPerInvocation[0].evalMetricResults = [
      {...makeMetricResult(1), score: undefined},
    ];
    installRuntime([unscored]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      `${METRIC} for ${AGENT_MODULE} Failed. Expected 0.8, but got undefined.`,
    );
  });

  it('prints a detail table for each metric when asked', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: true,
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const printed = String(infoSpy.mock.calls[0][0]);
    expect(printed).toContain(
      `Summary: \`PASSED\` for Metric: \`${METRIC}\`. Expected threshold: ` +
        '`0.8`, actual value: `1`.',
    );
    expect(printed).toContain('eval_status');
    expect(printed).toContain('actual_tool_calls');
    expect(printed).toContain('I rolled a 4.');
  });

  it('prints nothing when detailed results are turned off', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      printDetailedResults: false,
    });

    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe('AgentEvaluator.evaluateEvalSet arguments', () => {
  it('rejects a results manager without an app name', async () => {
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        evalSetResultsManager: new StubEvalSetResultsManager(),
      }),
    ).rejects.toThrowError(
      'app_name is required when eval_set_results_manager is provided.',
    );
  });

  it('rejects a call with neither criteria nor an eval config', async () => {
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
      }),
    ).rejects.toThrowError('`eval_config` is required.');
  });

  it('maps the deprecated criteria onto the eval config and warns', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const spy = installRuntime([makeCaseResult('roll_die', 1)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      criteria: {[METRIC]: THRESHOLD},
      printDetailedResults: false,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('`criteria` is deprecated'),
    );
    expect(spy.serviceOptions[0].evalConfig.criteria).toEqual({
      [METRIC]: THRESHOLD,
    });
  });

  it('forwards the results manager and persists before it throws', async () => {
    const evalSetResultsManager = new StubEvalSetResultsManager();
    installRuntime([makeCaseResult('roll_die', 0.1)]);
    createEvalService.mockImplementation(
      (options: CreateEvalServiceOptions): BaseEvalService => ({
        async *performInference() {
          // Nothing to yield: this run only checks the persistence order.
        },
        async *evaluate() {
          await options.evalSetResultsManager?.saveEvalSetResult(
            'dice_app',
            'dice',
            [makeCaseResult('roll_die', 0.1)],
          );
          yield makeCaseResult('roll_die', 0.1);
        },
      }),
    );

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: AGENT_MODULE,
        evalSet: EVAL_SET,
        evalConfig: EVAL_CONFIG,
        appName: 'dice_app',
        evalSetResultsManager,
        printDetailedResults: false,
      }),
    ).rejects.toThrowError('Following are all the test failures.');
    expect(evalSetResultsManager.saved).toHaveLength(1);
  });
});

describe('AgentEvaluator.evaluateEvalSet CSV output', () => {
  it('writes one row per metric per invocation', async () => {
    const outputFile = join(await makeWorkDir(), 'out', 'results.csv');
    installRuntime([makeCaseResult('roll_die', 0.9)]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      outputFile,
      printDetailedResults: false,
    });

    expect(await readFile(outputFile, 'utf-8')).toBe(
      'eval_set_id,eval_id,metric_name,threshold,score,eval_status,prompt,' +
        'expected_response,actual_response,expected_tool_calls,' +
        'actual_tool_calls\n' +
        'dice,roll_die,response_match_score,0.8,0.9,PASSED,Roll a die,' +
        'I rolled a 4.,I rolled a 4.,' +
        '"{""name"":""roll_die"",""args"":{""sides"":6}}",' +
        '"{""name"":""roll_die"",""args"":{""sides"":6}}"\n',
    );
  });

  it('falls back to the actual invocation when there is no expected one', async () => {
    const outputFile = join(await makeWorkDir(), 'results.csv');
    const result = makeCaseResult('roll_die', 0.9);
    result.evalMetricResultPerInvocation[0].expectedInvocation = undefined;
    installRuntime([result]);

    await AgentEvaluator.evaluateEvalSet({
      agentModule: AGENT_MODULE,
      evalSet: EVAL_SET,
      evalConfig: EVAL_CONFIG,
      outputFile,
      printDetailedResults: false,
    });

    const row = (await readFile(outputFile, 'utf-8')).split('\n')[1];
    expect(row).toBe(
      'dice,roll_die,response_match_score,0.8,0.9,PASSED,Roll a die,,' +
        'I rolled a 4.,,"{""name"":""roll_die"",""args"":{""sides"":6}}"',
    );
  });
});

describe('AgentEvaluator.findConfigForTestFile', () => {
  it('reads the config from the test file own folder', async () => {
    const workDir = await makeWorkDir();
    await writeFile(
      join(workDir, 'test_config.json'),
      '{"criteria": {"response_match_score": 0.3}}',
      'utf-8',
    );

    const config = await AgentEvaluator.findConfigForTestFile(
      join(workDir, 'roll.test.json'),
    );

    expect(config.criteria).toEqual({response_match_score: 0.3});
  });

  it('returns the defaults when the folder has no config', async () => {
    const workDir = await makeWorkDir();

    const config = await AgentEvaluator.findConfigForTestFile(
      join(workDir, 'roll.test.json'),
    );

    expect(config.criteria).toEqual({
      tool_trajectory_avg_score: 1.0,
      response_match_score: 0.8,
    });
  });
});

describe('AgentEvaluator.migrateEvalDataToNewSchema', () => {
  const LEGACY_DATA = [
    {
      query: 'Roll a die',
      reference: 'I rolled a 4.',
      expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
    },
  ];

  async function writeLegacy(
    workDir: string,
    data: unknown = LEGACY_DATA,
  ): Promise<string> {
    const oldFile = join(workDir, 'roll.test.json');
    await writeFile(oldFile, JSON.stringify(data), 'utf-8');
    return oldFile;
  }

  it.each([
    ['the old file path is empty', '', 'new.json'],
    ['the new file path is empty', 'old.json', ''],
  ])('rejects a migration when %s', async (_name, oldFile, newFile) => {
    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema({
        oldEvalDataFile: oldFile,
        newEvalDataFile: newFile,
      }),
    ).rejects.toThrowError(
      'One of old_eval_data_file or new_eval_data_file is empty.',
    );
  });

  it('converts an old format file to the eval set schema', async () => {
    const workDir = await makeWorkDir();
    const oldFile = await writeLegacy(workDir);
    const newFile = join(workDir, 'roll.evalset.json');

    await AgentEvaluator.migrateEvalDataToNewSchema({
      oldEvalDataFile: oldFile,
      newEvalDataFile: newFile,
    });

    const migrated: unknown = JSON.parse(await readFile(newFile, 'utf-8'));
    expect(migrated).toMatchObject({
      eval_cases: [
        {
          eval_id: oldFile,
          conversation: [
            {
              user_content: {parts: [{text: 'Roll a die'}], role: 'user'},
              final_response: {parts: [{text: 'I rolled a 4.'}], role: 'model'},
              intermediate_data: {
                tool_uses: [{name: 'roll_die', args: {sides: 6}}],
              },
            },
          ],
        },
      ],
    });
  });

  it('carries an explicit initial session into the eval set', async () => {
    const workDir = await makeWorkDir();
    const oldFile = await writeLegacy(workDir);
    const sessionFile = join(workDir, 'initial.session.json');
    await writeFile(
      sessionFile,
      '{"app_name": "dice", "user_id": "user", "state": {"last_roll": 4}}',
      'utf-8',
    );
    const newFile = join(workDir, 'roll.evalset.json');

    await AgentEvaluator.migrateEvalDataToNewSchema({
      oldEvalDataFile: oldFile,
      newEvalDataFile: newFile,
      initialSessionFile: sessionFile,
    });

    const migrated: unknown = JSON.parse(await readFile(newFile, 'utf-8'));
    expect(migrated).toMatchObject({
      eval_cases: [
        {
          session_input: {
            app_name: 'dice',
            user_id: 'user',
            state: {last_roll: 4},
          },
        },
      ],
    });
  });

  it('validates the old data against the config in its own folder', async () => {
    const workDir = await makeWorkDir();
    const oldFile = await writeLegacy(workDir, [{query: 'Roll a die'}]);
    await writeFile(
      join(workDir, 'test_config.json'),
      '{"criteria": {"response_match_score": 0.5}}',
      'utf-8',
    );

    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema({
        oldEvalDataFile: oldFile,
        newEvalDataFile: join(workDir, 'out.json'),
      }),
    ).rejects.toThrowError(
      /Samples for response_match_score must include 'query' and 'reference' keys/,
    );
  });

  it('rejects an initial session file that is not an object', async () => {
    const workDir = await makeWorkDir();
    const oldFile = await writeLegacy(workDir);
    const sessionFile = join(workDir, 'initial.session.json');
    await writeFile(sessionFile, '[1, 2]', 'utf-8');

    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema({
        oldEvalDataFile: oldFile,
        newEvalDataFile: join(workDir, 'out.json'),
        initialSessionFile: sessionFile,
      }),
    ).rejects.toThrowError(InputValidationError);
  });

  it('round-trips non-ASCII content through the migration', async () => {
    const workDir = await makeWorkDir();
    const oldFile = await writeLegacy(workDir, [
      {query: '😀 你好 café', reference: 'çà và'},
    ]);
    await writeFile(
      join(workDir, 'test_config.json'),
      '{"criteria": {"response_match_score": 0.5}}',
      'utf-8',
    );
    const newFile = join(workDir, 'roll.evalset.json');

    await AgentEvaluator.migrateEvalDataToNewSchema({
      oldEvalDataFile: oldFile,
      newEvalDataFile: newFile,
    });

    expect(await readFile(newFile, 'utf-8')).toContain('😀 你好 café');
  });
});

describe('AgentEvaluator.evaluate', () => {
  async function writeDataset(): Promise<string> {
    const workDir = await makeWorkDir();
    await writeFile(
      join(workDir, 'test_config.json'),
      `{"criteria": {"${METRIC}": ${THRESHOLD}}}`,
      'utf-8',
    );
    await writeFile(
      join(workDir, 'first.test.json'),
      JSON.stringify([{query: 'Roll a die', reference: 'I rolled a 4.'}]),
      'utf-8',
    );
    await writeFile(
      join(workDir, 'second.test.json'),
      JSON.stringify([{query: 'Roll again', reference: 'I rolled a 2.'}]),
      'utf-8',
    );
    await writeFile(join(workDir, 'notes.txt'), 'ignored', 'utf-8');
    return workDir;
  }

  it('runs every test file in a directory into one CSV', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const workDir = await writeDataset();
    const outputFile = join(workDir, 'results.csv');
    const spy = installRuntime([makeCaseResult('roll_die', 0.9)]);

    await AgentEvaluator.evaluate({
      agentModule: AGENT_MODULE,
      evalDatasetFilePathOrDir: workDir,
      numRuns: 1,
      outputFile,
      printDetailedResults: false,
    });

    expect(spy.serviceOptions).toHaveLength(2);
    expect(spy.serviceOptions[0].evalConfig.criteria).toEqual({
      [METRIC]: THRESHOLD,
    });
    const lines = (await readFile(outputFile, 'utf-8')).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('eval_set_id');
    expect(lines[1]).not.toContain('eval_set_id');
  });

  it('warns that a test file is in the older format', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const workDir = await writeDataset();
    installRuntime([makeCaseResult('roll_die', 0.9)]);

    await AgentEvaluator.evaluate({
      agentModule: AGENT_MODULE,
      evalDatasetFilePathOrDir: join(workDir, 'first.test.json'),
      numRuns: 1,
      printDetailedResults: false,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('appear to be in the older format'),
    );
  });

  it('reads a file already in the eval set schema', async () => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'dice.test.json');
    await writeFile(
      testFile,
      JSON.stringify({
        eval_set_id: 'dice',
        eval_cases: [
          {
            eval_id: 'roll_die',
            conversation: [
              {user_content: {parts: [{text: 'Roll a die'}], role: 'user'}},
            ],
          },
        ],
      }),
      'utf-8',
    );
    const spy = installRuntime([makeCaseResult('roll_die', 0.9)]);

    await AgentEvaluator.evaluate({
      agentModule: AGENT_MODULE,
      evalDatasetFilePathOrDir: testFile,
      numRuns: 1,
      printDetailedResults: false,
    });

    expect(spy.inferenceRequests[0].evalSetId).toBe('dice');
  });

  it('refuses an explicit initial session alongside an eval set file', async () => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'dice.test.json');
    await writeFile(
      testFile,
      '{"eval_set_id": "dice", "eval_cases": []}',
      'utf-8',
    );
    const sessionFile = join(workDir, 'initial.session.json');
    await writeFile(sessionFile, '{"app_name": "dice"}', 'utf-8');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: testFile,
        initialSessionFile: sessionFile,
      }),
    ).rejects.toThrowError(
      /Initial session should be specified as a part of EvalSet file/,
    );
  });

  it('rejects a path that is neither a file nor a directory', async () => {
    const missing = join(await makeWorkDir(), 'missing.test.json');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: missing,
      }),
    ).rejects.toThrowError(`Input path ${missing} is invalid.`);
  });

  it('rejects a test file that is not a list of objects', async () => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'bad.test.json');
    await writeFile(testFile, '["not an object"]', 'utf-8');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(`${testFile} must contain a list of dictionaries.`);
  });

  it('rejects an empty test file', async () => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'empty.test.json');
    await writeFile(testFile, '[]', 'utf-8');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError('The evaluation dataset is None or empty.');
  });

  it('rejects a criteria key the older format cannot be judged on', async () => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'roll.test.json');
    await writeFile(testFile, JSON.stringify([{query: 'Roll'}]), 'utf-8');
    await writeFile(
      join(workDir, 'test_config.json'),
      '{"criteria": {"hallucinations_v1": 0.5}}',
      'utf-8',
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(/Invalid criteria key: hallucinations_v1/);
  });

  it.each([
    ['tool_trajectory_avg_score', "'query' and 'expected_tool_use'"],
    ['response_evaluation_score', "'query'"],
  ])('rejects data missing the columns %s needs', async (metric, columns) => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'roll.test.json');
    await writeFile(testFile, JSON.stringify([{reference: 'x'}]), 'utf-8');
    await writeFile(
      join(workDir, 'test_config.json'),
      `{"criteria": {"${metric}": 0.5}}`,
      'utf-8',
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(
      `Samples for ${metric} must include ${columns} keys. The sample is ` +
        '[{"reference":"x"}].',
    );
  });

  it('rejects a results manager without an app name', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agentModule: AGENT_MODULE,
        evalDatasetFilePathOrDir: 'unused',
        evalSetResultsManager: new StubEvalSetResultsManager(),
      }),
    ).rejects.toThrowError(
      'app_name is required when eval_set_results_manager is provided.',
    );
  });

  it('forwards the results manager and the app name', async () => {
    const evalSetResultsManager = new StubEvalSetResultsManager();
    const workDir = await writeDataset();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const spy = installRuntime([makeCaseResult('roll_die', 0.9)]);

    await AgentEvaluator.evaluate({
      agentModule: AGENT_MODULE,
      evalDatasetFilePathOrDir: join(workDir, 'first.test.json'),
      appName: 'dice_app',
      evalSetResultsManager,
      numRuns: 1,
      printDetailedResults: false,
    });

    expect(spy.serviceOptions[0].evalSetResultsManager).toBe(
      evalSetResultsManager,
    );
    expect(spy.serviceOptions[0].evalConfig.criteria).toEqual({
      [METRIC]: THRESHOLD,
    });
  });

  it('reads non-ASCII eval data and initial session state', async () => {
    const workDir = await makeWorkDir();
    const testFile = join(workDir, 'roll.test.json');
    await writeFile(
      testFile,
      JSON.stringify([{query: '😀 你好 café', reference: 'çà và'}]),
      'utf-8',
    );
    const sessionFile = join(workDir, 'initial.session.json');
    await writeFile(sessionFile, '{"state": {"greeting": "你好"}}', 'utf-8');
    await writeFile(
      join(workDir, 'test_config.json'),
      `{"criteria": {"${METRIC}": ${THRESHOLD}}}`,
      'utf-8',
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const spy = installRuntime([makeCaseResult('roll_die', 0.9)]);

    await AgentEvaluator.evaluate({
      agentModule: AGENT_MODULE,
      evalDatasetFilePathOrDir: testFile,
      initialSessionFile: sessionFile,
      numRuns: 1,
      printDetailedResults: false,
    });

    const manager = spy.serviceOptions[0].evalSetsManager;
    const evalSetId = spy.inferenceRequests[0].evalSetId;
    const stored = await manager.getEvalSet('test_app', evalSetId);
    const invocation = stored?.evalCases[0].conversation?.[0];
    expect(invocation?.userContent.parts?.[0].text).toBe('😀 你好 café');
    expect(stored?.evalCases[0].sessionInput?.state).toEqual({
      greeting: '你好',
    });
  });
});
