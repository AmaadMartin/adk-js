/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEvaluator,
  AgentModuleExports,
  App,
  DEFAULT_EVAL_CONFIG,
  EvalCaseResult,
  EvalMetricResult,
  EvalMetricResultPerInvocation,
  EvalSet,
  EvalStatus,
  InMemoryArtifactService,
  Invocation,
  LlmAgent,
  NUM_RUNS,
  PrebuiltMetrics,
  setEvalRuntime,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {
  RecordingEvalSetResultsManager,
  StubEvalRuntime,
} from './stub_eval_service.js';

const EVAL_SET_ID = 'set-1';
const EVAL_ID = 'case-1';
const MATCH_METRIC = PrebuiltMetrics.RESPONSE_MATCH_SCORE;
const TRAJECTORY_METRIC = PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE;

const CSV_HEADER =
  'eval_set_id,eval_id,metric_name,threshold,score,eval_status,prompt,' +
  'expected_response,actual_response,expected_tool_calls,actual_tool_calls';

/** A module object exposing a root agent, as a caller's agent module would. */
function createAgentModule(): AgentModuleExports {
  return {rootAgent: new LlmAgent({name: 'root_agent'})};
}

function createInvocation(
  prompt: string,
  response?: string,
  toolCalls: FunctionCall[] = [],
): Invocation {
  return {
    invocationId: 'inv-1',
    userContent: {role: 'user', parts: [{text: prompt}]},
    finalResponse: response
      ? {role: 'model', parts: [{text: response}]}
      : undefined,
    intermediateData: {
      toolUses: toolCalls,
      toolResponses: [],
      intermediateResponses: [],
    },
  };
}

function createMetricResult(
  score: number | undefined,
  threshold: number,
  metricName: string = MATCH_METRIC,
): EvalMetricResult {
  let evalStatus = EvalStatus.NOT_EVALUATED;
  if (score !== undefined) {
    evalStatus = score >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
  }
  return {metricName, threshold, criterion: {threshold}, score, evalStatus};
}

function createPerInvocation(
  evalMetricResults: EvalMetricResult[],
  actual: Invocation = createInvocation('what is the weather?', 'it is warm'),
  expected?: Invocation,
): EvalMetricResultPerInvocation {
  return {
    actualInvocation: actual,
    expectedInvocation: expected,
    evalMetricResults,
  };
}

function createEvalCaseResult(
  evalMetricResultPerInvocation: EvalMetricResultPerInvocation[],
  finalEvalStatus = EvalStatus.PASSED,
  evalId = EVAL_ID,
): EvalCaseResult {
  return {
    evalSetId: EVAL_SET_ID,
    evalId,
    finalEvalStatus,
    evalMetricResultPerInvocation,
  };
}

function createEvalSet(evalIds: string[] = [EVAL_ID]): EvalSet {
  return {
    evalSetId: EVAL_SET_ID,
    evalCases: evalIds.map((evalId) => ({
      evalId,
      conversation: [createInvocation('what is the weather?', 'it is warm')],
      creationTimestamp: 0,
    })),
    creationTimestamp: 0,
  };
}

/** A config scoring the response match metric at the given threshold. */
function createEvalConfig(threshold: number) {
  return {criteria: {[MATCH_METRIC]: threshold}};
}

/** One eval case result whose single metric scored `score`. */
function scoredOnce(score: number | undefined, threshold: number) {
  return [
    createEvalCaseResult([
      createPerInvocation([createMetricResult(score, threshold)]),
    ]),
  ];
}

describe('AgentEvaluator.evaluateEvalSet', () => {
  let runtime: StubEvalRuntime;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  /** Installs a runtime whose eval service yields the given results. */
  function install(evalCaseResults: EvalCaseResult[]): StubEvalRuntime {
    runtime = new StubEvalRuntime(evalCaseResults);
    setEvalRuntime(runtime);
    return runtime;
  }

  beforeEach(() => {
    install(scoredOnce(1, 0.8));
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setEvalRuntime(undefined);
    vi.restoreAllMocks();
  });

  it('resolves when every metric reaches its threshold', async () => {
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).resolves.toBeUndefined();
  });

  it('reports the metric, the threshold and the mean score of a failure', async () => {
    install([
      createEvalCaseResult([
        createPerInvocation([createMetricResult(1, 0.6)]),
        createPerInvocation([createMetricResult(0, 0.6)]),
      ]),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.6),
      }),
    ).rejects.toThrowError(
      `${MATCH_METRIC} for the agent module Failed. Expected 0.6, but got 0.5.`,
    );
  });

  it('names the specifier of the agent module in a failure', async () => {
    install(scoredOnce(0, 0.8));
    const specifier = new URL('./fixtures/agent.ts', import.meta.url).href;

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: specifier,
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).rejects.toThrowError(`${MATCH_METRIC} for ${specifier} Failed.`);
  });

  it('reports a run that failed without producing any metric result', async () => {
    install([createEvalCaseResult([], EvalStatus.FAILED)]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).rejects.toThrowError(
      `${EVAL_ID} for the agent module Failed. 1 of 1 runs were recorded as ` +
        'failed without producing any metric results.',
    );
  });

  it('ignores a failed run that did produce a metric result', async () => {
    install([
      createEvalCaseResult(
        [createPerInvocation([createMetricResult(1, 0.8)])],
        EvalStatus.FAILED,
      ),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).resolves.toBeUndefined();
  });

  it('reports NOT_EVALUATED when no invocation produced a score', async () => {
    install(scoredOnce(undefined, 0.8));

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).rejects.toThrowError(
      `${MATCH_METRIC} for the agent module Failed. Expected 0.8, but got ` +
        'undefined.',
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('`NOT_EVALUATED`'),
    );
  });

  it('logs the per-invocation detail of a failing metric', async () => {
    install([
      createEvalCaseResult([
        createPerInvocation(
          [createMetricResult(0, 0.8)],
          createInvocation('actual prompt', 'actual answer', [
            {name: 'get_weather', args: {city: 'sf'}},
          ]),
          createInvocation('expected prompt', 'expected answer'),
        ),
      ]),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).rejects.toThrowError('Following are all the test failures.');

    const logged = infoSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('expected prompt');
    expect(logged).toContain('expected answer');
    expect(logged).toContain('actual answer');
    expect(logged).toContain('get_weather');
    expect(logged).toContain('FAILED');
  });

  it('logs nothing and adds the re-run hint when detail is off', async () => {
    install(scoredOnce(0, 0.8));

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
        printDetailedResults: false,
      }),
    ).rejects.toThrowError(
      'If you are looking to get more details on the failures, then please ' +
        're-run this test with `printDetailedResults` set to `true`.',
    );
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('runs inference once per run and groups the results by eval id', async () => {
    install([
      createEvalCaseResult([createPerInvocation([createMetricResult(1, 0.6)])]),
      createEvalCaseResult([createPerInvocation([createMetricResult(0, 0.6)])]),
    ]);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.6),
        numRuns: 3,
      }),
    ).rejects.toThrowError('Expected 0.6, but got 0.5.');

    expect(runtime.service?.inferenceRequests).toHaveLength(3);
    expect(runtime.service?.evaluateRequests[0].inferenceResults).toHaveLength(
      3,
    );
  });

  it('defaults to NUM_RUNS runs', async () => {
    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
    });

    expect(runtime.service?.inferenceRequests).toHaveLength(NUM_RUNS);
  });

  it('requests live inference when the config names a live model', async () => {
    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig: {
        ...createEvalConfig(0.8),
        liveModelConfig: {timeoutSeconds: 42},
      },
      numRuns: 1,
    });

    expect(runtime.service?.inferenceRequests[0].inferenceConfig).toEqual({
      useLive: true,
      liveTimeoutSeconds: 42,
    });
  });

  it('requests non-live inference when the config names no live model', async () => {
    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
      numRuns: 1,
    });

    expect(runtime.service?.inferenceRequests[0].inferenceConfig).toEqual({
      useLive: false,
    });
  });

  it('passes the resolved app, the agent and the artifact service on', async () => {
    const rootAgent = new LlmAgent({name: 'root_agent'});
    const app = new App({name: 'weather_app', rootAgent});
    const artifactService = new InMemoryArtifactService();

    await AgentEvaluator.evaluateEvalSet({
      agentModule: {agent: {rootAgent, app}},
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
      artifactService,
      numRuns: 1,
    });

    expect(runtime.params?.rootAgent).toBe(rootAgent);
    expect(runtime.params?.app).toBe(app);
    expect(runtime.params?.artifactService).toBe(artifactService);
  });

  it('leaves the app undefined when the module exposes none', async () => {
    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
      numRuns: 1,
    });

    expect(runtime.params?.app).toBeUndefined();
  });

  it('seeds the eval sets manager with every eval case', async () => {
    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(['case-a', 'case-b']),
      evalConfig: createEvalConfig(0.8),
      appName: 'weather_app',
      numRuns: 1,
    });

    const seeded = await runtime.params?.evalSetsManager.getEvalSet(
      'weather_app',
      EVAL_SET_ID,
    );
    expect(seeded?.evalCases.map((evalCase) => evalCase.evalId)).toEqual([
      'case-a',
      'case-b',
    ]);
  });

  it('evaluates a named sub-agent instead of the root agent', async () => {
    const subAgent = new LlmAgent({name: 'weather_agent'});
    const rootAgent = new LlmAgent({name: 'root_agent', subAgents: [subAgent]});

    await AgentEvaluator.evaluateEvalSet({
      agentModule: {rootAgent},
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
      agentName: 'weather_agent',
      numRuns: 1,
    });

    expect(runtime.params?.rootAgent).toBe(subAgent);
  });

  it('rejects a results manager that comes without an app name', async () => {
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
        evalSetResultsManager: new RecordingEvalSetResultsManager(),
      }),
    ).rejects.toThrowError(
      'app_name is required when eval_set_results_manager is provided.',
    );
  });

  it('passes the results manager and the app name on', async () => {
    const evalSetResultsManager = new RecordingEvalSetResultsManager();

    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
      appName: 'weather_app',
      evalSetResultsManager,
      numRuns: 1,
    });

    expect(runtime.params?.evalSetResultsManager).toBe(evalSetResultsManager);
    expect(evalSetResultsManager.saved).toHaveLength(1);
  });

  it('persists the results even when the run then fails', async () => {
    install(scoredOnce(0, 0.8));
    const evalSetResultsManager = new RecordingEvalSetResultsManager();

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
        appName: 'weather_app',
        evalSetResultsManager,
      }),
    ).rejects.toThrowError('Following are all the test failures.');

    expect(evalSetResultsManager.saved).toHaveLength(1);
    expect(evalSetResultsManager.saved[0].evalCaseResults).toHaveLength(1);
  });

  it('forwards the whole eval config to the runtime', async () => {
    const evalConfig = {
      ...createEvalConfig(0.8),
      customMetrics: {[MATCH_METRIC]: {codeConfig: {name: './score.js'}}},
      userSimulatorConfig: {turns: 3},
    };

    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig,
      numRuns: 1,
    });

    expect(runtime.params?.evalConfig).toBe(evalConfig);
  });

  it('reports the missing runtime only after the options are validated', async () => {
    setEvalRuntime(undefined);

    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
        evalSetResultsManager: new RecordingEvalSetResultsManager(),
      }),
    ).rejects.toThrowError(
      'app_name is required when eval_set_results_manager is provided.',
    );
    await expect(
      AgentEvaluator.evaluateEvalSet({
        agentModule: createAgentModule(),
        evalSet: createEvalSet(),
        evalConfig: createEvalConfig(0.8),
      }),
    ).rejects.toThrowError('The eval runtime is not available.');
  });
});

describe('AgentEvaluator CSV output', () => {
  let workDir: string;
  let outputFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'adk-eval-csv-'));
    outputFile = path.join(workDir, 'results.csv');
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    setEvalRuntime(undefined);
    vi.restoreAllMocks();
  });

  /** Runs one eval set and returns the CSV it wrote. */
  async function runAndRead(
    evalCaseResults: EvalCaseResult[],
    csvPath: string = outputFile,
  ): Promise<string> {
    setEvalRuntime(new StubEvalRuntime(evalCaseResults));
    await AgentEvaluator.evaluateEvalSet({
      agentModule: createAgentModule(),
      evalSet: createEvalSet(),
      evalConfig: createEvalConfig(0.8),
      numRuns: 1,
      outputFile: csvPath,
      printDetailedResults: false,
    }).catch(() => undefined);
    return readFile(csvPath, 'utf-8');
  }

  it('writes one row per metric per invocation, in the documented order', async () => {
    const csv = await runAndRead([
      createEvalCaseResult([
        createPerInvocation(
          [createMetricResult(1, 0.8)],
          createInvocation('actual prompt', 'actual answer', [
            {name: 'get_weather', args: {city: 'sf'}},
          ]),
          createInvocation('expected prompt', 'expected answer', [
            {name: 'get_weather', args: {city: 'nyc'}},
          ]),
        ),
      ]),
    ]);

    expect(csv.split('\n')[0]).toBe(CSV_HEADER);
    expect(csv.split('\n')[1]).toBe(
      `${EVAL_SET_ID},${EVAL_ID},${MATCH_METRIC},0.8,1,PASSED,expected ` +
        'prompt,expected answer,actual answer,' +
        '"{""name"":""get_weather"",""args"":{""city"":""nyc""}}",' +
        '"{""name"":""get_weather"",""args"":{""city"":""sf""}}"',
    );
  });

  it('leaves the expected columns empty when there is no expected invocation', async () => {
    const csv = await runAndRead([
      createEvalCaseResult([
        createPerInvocation(
          [createMetricResult(0.5, 0.8)],
          createInvocation('actual prompt', 'actual answer'),
        ),
      ]),
    ]);

    expect(csv.split('\n')[1]).toBe(
      `${EVAL_SET_ID},${EVAL_ID},${MATCH_METRIC},0.8,0.5,FAILED,actual ` +
        'prompt,,actual answer,,',
    );
  });

  it('creates the parent directories of the output file', async () => {
    const nested = path.join(workDir, 'reports', 'today', 'results.csv');

    const csv = await runAndRead(scoredOnce(1, 0.8), nested);

    expect(csv.split('\n')[0]).toBe(CSV_HEADER);
  });

  it('appends a second run without repeating the header', async () => {
    await runAndRead(scoredOnce(1, 0.8));
    const csv = await runAndRead(scoredOnce(1, 0.8));

    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line === CSV_HEADER)).toHaveLength(1);
  });

  it('quotes a field holding a comma, a quote and a line break', async () => {
    const csv = await runAndRead([
      createEvalCaseResult([
        createPerInvocation(
          [createMetricResult(1, 0.8)],
          createInvocation('prompt', 'he said "hi", then\nleft'),
        ),
      ]),
    ]);

    expect(csv).toContain('"he said ""hi"", then\nleft"');
  });
});

describe('AgentEvaluator.findConfigForTestFile', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'adk-eval-config-'));
  });

  it('reads the config from the folder holding the test file', async () => {
    const child = path.join(workDir, 'child');
    await mkdir(child);
    await writeFile(
      path.join(workDir, 'test_config.json'),
      JSON.stringify({criteria: {[MATCH_METRIC]: 0.1}}),
    );
    await writeFile(
      path.join(child, 'test_config.json'),
      JSON.stringify({criteria: {[MATCH_METRIC]: 0.9}}),
    );

    const config = await AgentEvaluator.findConfigForTestFile(
      path.join(child, 'a.test.json'),
    );

    expect(config.criteria).toEqual({[MATCH_METRIC]: 0.9});
  });

  it('ignores a config in a parent folder', async () => {
    const child = path.join(workDir, 'child');
    await mkdir(child);
    await writeFile(
      path.join(workDir, 'test_config.json'),
      JSON.stringify({criteria: {[MATCH_METRIC]: 0.1}}),
    );

    const config = await AgentEvaluator.findConfigForTestFile(
      path.join(child, 'a.test.json'),
    );

    expect(config).toEqual(DEFAULT_EVAL_CONFIG);
  });

  it('falls back to the default config when there is none', async () => {
    const config = await AgentEvaluator.findConfigForTestFile(
      path.join(workDir, 'a.test.json'),
    );

    expect(config).toEqual(DEFAULT_EVAL_CONFIG);
  });
});

describe('AgentEvaluator.evaluate', () => {
  let workDir: string;
  let runtime: StubEvalRuntime;

  /** Writes a file under the work directory and returns its path. */
  async function write(fileName: string, content: string): Promise<string> {
    const filePath = path.join(workDir, fileName);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /** An eval set file in the current schema, with the given id. */
  function evalSetFile(evalSetId: string): string {
    return JSON.stringify({
      eval_set_id: evalSetId,
      creation_timestamp: 0,
      eval_cases: [
        {
          eval_id: EVAL_ID,
          creation_timestamp: 0,
          conversation: [
            {
              invocation_id: 'inv-1',
              user_content: {role: 'user', parts: [{text: 'hi'}]},
            },
          ],
        },
      ],
    });
  }

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'adk-eval-run-'));
    runtime = new StubEvalRuntime(scoredOnce(1, 0.8));
    setEvalRuntime(runtime);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setEvalRuntime(undefined);
    vi.restoreAllMocks();
  });

  it('scores an eval set file written in the current schema', async () => {
    const testFile = await write('a.test.json', evalSetFile('set-a'));

    await AgentEvaluator.evaluate({
      agentModule: createAgentModule(),
      evalDatasetFilePathOrDir: testFile,
      numRuns: 1,
    });

    expect(runtime.service?.inferenceRequests[0].evalSetId).toBe('set-a');
  });

  it('scores every test file under a directory, in a stable order', async () => {
    await write('b.test.json', evalSetFile('set-b'));
    await write('a.test.json', evalSetFile('set-a'));
    await write('ignored.json', evalSetFile('set-ignored'));
    await mkdir(path.join(workDir, 'nested'));
    await writeFile(
      path.join(workDir, 'nested', 'c.test.json'),
      evalSetFile('set-c'),
      'utf-8',
    );

    await AgentEvaluator.evaluate({
      agentModule: createAgentModule(),
      evalDatasetFilePathOrDir: workDir,
      numRuns: 1,
    });

    expect(
      runtime.allServices.map(
        (service) => service.inferenceRequests[0].evalSetId,
      ),
    ).toEqual(['set-a', 'set-b', 'set-c']);
  });

  it('surfaces a file system error that is not a missing path', async () => {
    // A NUL byte makes `fs.stat` reject before the syscall, on every platform.
    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: path.join(workDir, 'a\u0000b.test.json'),
      }),
    ).rejects.toThrowError('without null bytes');
  });

  it('reads eval data written in the older format', async () => {
    const testFile = await write(
      'legacy.test.json',
      JSON.stringify([
        {query: 'hi', reference: 'hello', expected_tool_use: []},
      ]),
    );

    await AgentEvaluator.evaluate({
      agentModule: createAgentModule(),
      evalDatasetFilePathOrDir: testFile,
      numRuns: 1,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('appear to be in older format'),
    );
    const seeded = await runtime.params?.evalSetsManager.getEvalSet(
      'test_app',
      runtime.service?.inferenceRequests[0].evalSetId ?? '',
    );
    expect(seeded?.evalCases[0].evalId).toBe(testFile);
  });

  it('carries an initial session file into the eval case', async () => {
    const testFile = await write(
      'legacy.test.json',
      JSON.stringify([
        {query: 'hi', reference: 'hello', expected_tool_use: []},
      ]),
    );
    const sessionFile = await write(
      'session.json',
      JSON.stringify({
        app_name: 'weather_app',
        user_id: 'u1',
        state: {city: 'sf'},
      }),
    );

    await AgentEvaluator.evaluate({
      agentModule: createAgentModule(),
      evalDatasetFilePathOrDir: testFile,
      initialSessionFile: sessionFile,
      numRuns: 1,
    });

    const seeded = await runtime.params?.evalSetsManager.getEvalSet(
      'test_app',
      runtime.service?.inferenceRequests[0].evalSetId ?? '',
    );
    expect(seeded?.evalCases[0].sessionInput).toEqual({
      appName: 'weather_app',
      userId: 'u1',
      state: {city: 'sf'},
    });
  });

  it('rejects an initial session alongside a current-schema eval set', async () => {
    const testFile = await write('a.test.json', evalSetFile('set-a'));
    const sessionFile = await write(
      'session.json',
      JSON.stringify({app_name: 'weather_app'}),
    );

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
        initialSessionFile: sessionFile,
      }),
    ).rejects.toThrowError(
      'Initial session should be specified as a part of EvalSet file.',
    );
  });

  it('rejects an initial session file that is not a JSON object', async () => {
    const testFile = await write('a.test.json', evalSetFile('set-a'));
    const sessionFile = await write('session.json', '[]');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
        initialSessionFile: sessionFile,
      }),
    ).rejects.toThrowError('must hold a JSON object');
  });

  it('surfaces a parse error instead of reading the file as older data', async () => {
    const testFile = await write('broken.test.json', '{not json');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(SyntaxError);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports a path that names no eval data', async () => {
    const missing = path.join(workDir, 'absent.test.json');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: missing,
      }),
    ).rejects.toThrowError(`Input path ${missing} is invalid.`);
  });

  it('reports a file that does not hold a list of records', async () => {
    const testFile = await write('bad.test.json', '{"query": "hi"}');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(`${testFile} must contain a list of dictionaries.`);
  });

  it('rejects a criteria key that names no known metric', async () => {
    await write(
      'test_config.json',
      JSON.stringify({criteria: {made_up_metric: 0.5}}),
    );
    const testFile = await write(
      'legacy.test.json',
      JSON.stringify([{query: 'hi'}]),
    );

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError('Invalid criteria key: made_up_metric.');
  });

  it('rejects a sample missing the columns a metric needs', async () => {
    await write(
      'test_config.json',
      JSON.stringify({criteria: {[MATCH_METRIC]: 0.5}}),
    );
    const testFile = await write(
      'legacy.test.json',
      JSON.stringify([{query: 'hi'}]),
    );

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(
      `Samples for ${MATCH_METRIC} must include 'query' and 'reference' keys.`,
    );
  });

  it('rejects an empty sample list against a metric that needs columns', async () => {
    await write(
      'test_config.json',
      JSON.stringify({criteria: {[TRAJECTORY_METRIC]: 0.5}}),
    );
    const testFile = await write('legacy.test.json', '[]');

    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: testFile,
      }),
    ).rejects.toThrowError(
      `Samples for ${TRAJECTORY_METRIC} must include 'query' and ` +
        "'expected_tool_use' keys.",
    );
  });

  it('accepts a sample that carries every column its metrics need', async () => {
    await write(
      'test_config.json',
      JSON.stringify({
        criteria: {
          [TRAJECTORY_METRIC]: 1,
          [PrebuiltMetrics.RESPONSE_EVALUATION_SCORE]: 0.5,
        },
      }),
    );
    const testFile = await write(
      'legacy.test.json',
      JSON.stringify([{query: 'hi', expected_tool_use: []}]),
    );

    await AgentEvaluator.evaluate({
      agentModule: createAgentModule(),
      evalDatasetFilePathOrDir: testFile,
      numRuns: 1,
    });

    expect(runtime.allServices).toHaveLength(1);
  });

  it('rejects a results manager that comes without an app name', async () => {
    await expect(
      AgentEvaluator.evaluate({
        agentModule: createAgentModule(),
        evalDatasetFilePathOrDir: workDir,
        evalSetResultsManager: new RecordingEvalSetResultsManager(),
      }),
    ).rejects.toThrowError(
      'app_name is required when eval_set_results_manager is provided.',
    );
  });
});

describe('AgentEvaluator.migrateEvalDataToNewSchema', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'adk-eval-migrate-'));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function write(fileName: string, content: string): Promise<string> {
    const filePath = path.join(workDir, fileName);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  it('rewrites data in the older format as an eval set file', async () => {
    const oldFile = await write(
      'old.test.json',
      JSON.stringify([
        {
          query: 'what is the weather?',
          reference: 'it is warm',
          expected_tool_use: [
            {tool_name: 'get_weather', tool_input: {city: 'sf'}},
          ],
        },
      ]),
    );
    const newFile = path.join(workDir, 'new.evalset.json');

    await AgentEvaluator.migrateEvalDataToNewSchema(oldFile, newFile);

    const written = JSON.parse(await readFile(newFile, 'utf-8'));
    const invocation = written.eval_cases[0].conversation[0];
    expect(written.eval_cases[0].eval_id).toBe(oldFile);
    expect(invocation.user_content.parts[0].text).toBe('what is the weather?');
    expect(invocation.final_response.parts[0].text).toBe('it is warm');
    expect(invocation.intermediate_data.tool_uses).toEqual([
      {name: 'get_weather', args: {city: 'sf'}},
    ]);
  });

  it('carries an initial session file into the eval case', async () => {
    const oldFile = await write(
      'old.test.json',
      JSON.stringify([
        {query: 'hi', reference: 'hello', expected_tool_use: []},
      ]),
    );
    const sessionFile = await write(
      'session.json',
      JSON.stringify({
        app_name: 'weather_app',
        user_id: 'u1',
        state: {city: 'sf'},
      }),
    );
    const newFile = path.join(workDir, 'new.evalset.json');

    await AgentEvaluator.migrateEvalDataToNewSchema(
      oldFile,
      newFile,
      sessionFile,
    );

    const written = JSON.parse(await readFile(newFile, 'utf-8'));
    expect(written.eval_cases[0].session_input).toEqual({
      app_name: 'weather_app',
      user_id: 'u1',
      state: {city: 'sf'},
    });
  });

  it('rejects an empty source or destination path', async () => {
    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema('', 'new.json'),
    ).rejects.toThrowError(
      'One of oldEvalDataFile or newEvalDataFile is empty.',
    );
    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema('old.json', ''),
    ).rejects.toThrowError(
      'One of oldEvalDataFile or newEvalDataFile is empty.',
    );
  });

  it('applies the config in the source folder while migrating', async () => {
    await write(
      'test_config.json',
      JSON.stringify({criteria: {[MATCH_METRIC]: 0.5}}),
    );
    const oldFile = await write(
      'old.test.json',
      JSON.stringify([{query: 'hi'}]),
    );

    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema(
        oldFile,
        path.join(workDir, 'new.json'),
      ),
    ).rejects.toThrowError(
      `Samples for ${MATCH_METRIC} must include 'query' and 'reference' keys.`,
    );
  });

  it('reports a source folder that holds no eval data', async () => {
    const emptyDir = path.join(workDir, 'empty');
    await mkdir(emptyDir);

    await expect(
      AgentEvaluator.migrateEvalDataToNewSchema(
        emptyDir,
        path.join(workDir, 'new.json'),
      ),
    ).rejects.toThrowError('The evaluation dataset is None or empty.');
  });

  it('migrates the first test file of a source folder', async () => {
    const sourceDir = path.join(workDir, 'cases');
    await mkdir(sourceDir);
    await writeFile(
      path.join(sourceDir, 'a.test.json'),
      JSON.stringify([
        {query: 'first', reference: 'one', expected_tool_use: []},
      ]),
      'utf-8',
    );
    const newFile = path.join(workDir, 'new.json');

    await AgentEvaluator.migrateEvalDataToNewSchema(sourceDir, newFile);

    const written = JSON.parse(await readFile(newFile, 'utf-8'));
    expect(
      written.eval_cases[0].conversation[0].user_content.parts[0].text,
    ).toBe('first');
  });

  it('round-trips text that is not ASCII', async () => {
    const text = '😀 你好 café';
    const oldFile = await write(
      'old.test.json',
      JSON.stringify([{query: text, reference: text, expected_tool_use: []}]),
    );
    const newFile = path.join(workDir, 'new.json');

    await AgentEvaluator.migrateEvalDataToNewSchema(oldFile, newFile);

    const written = JSON.parse(await readFile(newFile, 'utf-8'));
    expect(
      written.eval_cases[0].conversation[0].user_content.parts[0].text,
    ).toBe(text);
  });
});
