/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scores an agent against recorded eval data.
 *
 * This is the entry point an application author calls from their own test
 * suite. It is a port of adk-python's
 * `src/google/adk/evaluation/agent_evaluator.py`.
 */

import {Content} from '@google/genai';
import {Stats} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {appendCsv} from '../utils/csv_utils.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {renderGridTable} from '../utils/text_table_utils.js';
import {
  AgentModuleRef,
  describeAgentModule,
  resolveAgentForEval,
} from './agent_module_loader.js';
import {
  EvaluateRequest,
  InferenceConfig,
  InferenceResult,
} from './base_eval_service.js';
import {
  getAllToolCalls,
  IntermediateDataType,
  Invocation,
} from './eval_case.js';
import {
  Criterion,
  EvalConfig,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
} from './eval_config.js';
import {isRecord, parseEvalSet, serializeEvalSet} from './eval_json.js';
import {
  EvalMetricResult,
  EvalStatus,
  getMetricThreshold,
  PrebuiltMetrics,
} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';
import {getEvalRuntime} from './eval_runtime.js';
import {EvalSet} from './eval_set.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {InMemoryEvalSetsManager} from './in_memory_eval_sets_manager.js';
import {convertLegacyEvalSet} from './legacy_eval_set_converter.js';

/** How many times every entry of an eval dataset is assessed by default. */
export const NUM_RUNS = 2;

const TOOL_TRAJECTORY_SCORE_KEY = PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE;
const RESPONSE_EVALUATION_SCORE_KEY = PrebuiltMetrics.RESPONSE_EVALUATION_SCORE;
const RESPONSE_MATCH_SCORE_KEY = PrebuiltMetrics.RESPONSE_MATCH_SCORE;
const SAFETY_V1_KEY = PrebuiltMetrics.SAFETY_V1;

/** The metric names an eval config may name as criteria. */
const ALLOWED_CRITERIA: readonly string[] = [
  TOOL_TRAJECTORY_SCORE_KEY,
  RESPONSE_EVALUATION_SCORE_KEY,
  RESPONSE_MATCH_SCORE_KEY,
  SAFETY_V1_KEY,
];

/** Columns of eval data written in ADK's original format. */
const QUERY_COLUMN = 'query';
const REFERENCE_COLUMN = 'reference';
const EXPECTED_TOOL_USE_COLUMN = 'expected_tool_use';

/** Characters a cell of the detail table may hold before it wraps. */
const MAX_DETAIL_COLUMN_WIDTH = 25;

/** The suffix that marks an eval data file inside a test directory. */
const TEST_FILE_SUFFIX = '.test.json';

/** The config file read from the folder holding a test file. */
const TEST_CONFIG_FILE = 'test_config.json';

/** Used when the caller persists no results and so names no app. */
const DEFAULT_APP_NAME = 'test_app';

/** Columns of the per-invocation detail table, in order. */
const DETAIL_COLUMNS: readonly string[] = [
  'eval_status',
  'score',
  'threshold',
  'prompt',
  'expected_response',
  'actual_response',
  'expected_tool_calls',
  'actual_tool_calls',
];

/**
 * Columns of the results CSV, in order. Tooling reads these files, so the
 * names stay snake_case as adk-python writes them.
 */
const CSV_COLUMNS: readonly string[] = [
  'eval_set_id',
  'eval_id',
  'metric_name',
  'threshold',
  'score',
  'eval_status',
  'prompt',
  'expected_response',
  'actual_response',
  'expected_tool_calls',
  'actual_tool_calls',
];

/** Thrown when one or more eval cases scored below their threshold. */
export class EvalFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFailureError';
  }
}

/** One metric result together with the invocations it was computed from. */
interface EvalMetricResultWithInvocation {
  actualInvocation: Invocation;
  expectedInvocation?: Invocation;
  evalMetricResult: EvalMetricResult;
}

/** Options for {@link AgentEvaluator.evaluateEvalSet}. */
export interface EvaluateEvalSetOptions {
  /** The module defining the agent, or its specifier. */
  agentModule: AgentModuleRef;

  evalSet: EvalSet;

  /** The metrics to score, and the threshold each must reach. */
  evalConfig: EvalConfig;

  /** Defaults to {@link NUM_RUNS}. */
  numRuns?: number;

  /** Evaluate a sub-agent instead of the root agent. */
  agentName?: string;

  /** Whether to log the per-invocation detail table. Defaults to true. */
  printDetailedResults?: boolean;

  /** Loads the artifacts the eval cases reach for. */
  artifactService?: BaseArtifactService;

  /** CSV path for per-invocation results. Parent directories are created. */
  outputFile?: string;

  /** The app name results are persisted under. */
  appName?: string;

  /** Persists the results of the run. Requires {@link appName}. */
  evalSetResultsManager?: EvalSetResultsManager;
}

/** Options for {@link AgentEvaluator.evaluate}. */
export interface EvaluateOptions {
  /** The module defining the agent, or its specifier. */
  agentModule: AgentModuleRef;

  /** A `*.test.json` file, or a directory searched recursively for them. */
  evalDatasetFilePathOrDir: string;

  /** Defaults to {@link NUM_RUNS}. */
  numRuns?: number;

  /** Evaluate a sub-agent instead of the root agent. */
  agentName?: string;

  /** JSON file holding the session state every eval case starts from. */
  initialSessionFile?: string;

  /** Whether to log the per-invocation detail table. Defaults to true. */
  printDetailedResults?: boolean;

  /** Loads the artifacts the eval cases reach for. */
  artifactService?: BaseArtifactService;

  /**
   * CSV path for per-invocation results. Results from every test file are
   * appended to the same file.
   */
  outputFile?: string;

  /** The app name results are persisted under. */
  appName?: string;

  /** Persists the results of the run. Requires {@link appName}. */
  evalSetResultsManager?: EvalSetResultsManager;
}

/** Returns the file information for a path, or undefined when it is absent. */
async function statOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch (err: unknown) {
    if (isRecord(err) && err['code'] === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/** Returns the `.test.json` files under a directory, in a stable order. */
async function listTestFilesInDir(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, {recursive: true});
  return entries
    .filter((entry) => entry.endsWith(TEST_FILE_SUFFIX))
    .map((entry) => path.join(directory, entry))
    .sort();
}

/** Reads a JSON file holding a list of records in ADK's original format. */
async function loadLegacyFile(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new InputValidationError(
      `${filePath} must contain a list of dictionaries.`,
    );
  }
  return parsed;
}

/**
 * Loads eval data in ADK's original format from a file, or from every
 * `.test.json` file under a directory.
 *
 * @throws {InputValidationError} When the path names neither a file nor a
 *   directory.
 */
async function loadDataset(
  input: string,
): Promise<Array<Array<Record<string, unknown>>>> {
  const info = await statOrUndefined(input);
  if (info?.isDirectory()) {
    const testFiles = await listTestFilesInDir(input);
    const datasets: Array<Array<Record<string, unknown>>> = [];
    for (const testFile of testFiles) {
      datasets.push(await loadLegacyFile(testFile));
    }
    return datasets;
  }
  if (info?.isFile()) {
    return [await loadLegacyFile(input)];
  }
  throw new InputValidationError(`Input path ${input} is invalid.`);
}

/**
 * Checks that the criteria of an eval config can be scored against the
 * dataset. Only the first row is inspected, as adk-python does.
 *
 * @throws {InputValidationError} When a criterion is unknown, or when the
 *   dataset lacks a column that a criterion needs.
 */
function validateInput(
  evalDataset: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  criteria: Record<string, Criterion>,
): void {
  for (const key of Object.keys(criteria)) {
    if (!ALLOWED_CRITERIA.includes(key)) {
      throw new InputValidationError(
        `Invalid criteria key: ${key}. Expected one of ` +
          `${ALLOWED_CRITERIA.join(', ')}.`,
      );
    }
  }

  const sample = evalDataset[0];
  const firstQuery: Record<string, unknown> = sample[0] ?? {};
  const requireColumns = (metricName: string, columns: string[]): void => {
    if (columns.every((column) => column in firstQuery)) {
      return;
    }
    const quoted = columns.map((column) => `'${column}'`).join(' and ');
    throw new InputValidationError(
      `Samples for ${metricName} must include ${quoted} keys. The sample is ` +
        `${JSON.stringify(sample)}.`,
    );
  };

  if (TOOL_TRAJECTORY_SCORE_KEY in criteria) {
    requireColumns(TOOL_TRAJECTORY_SCORE_KEY, [
      QUERY_COLUMN,
      EXPECTED_TOOL_USE_COLUMN,
    ]);
  }
  if (RESPONSE_EVALUATION_SCORE_KEY in criteria) {
    requireColumns(RESPONSE_EVALUATION_SCORE_KEY, [QUERY_COLUMN]);
  }
  if (RESPONSE_MATCH_SCORE_KEY in criteria) {
    requireColumns(RESPONSE_MATCH_SCORE_KEY, [QUERY_COLUMN, REFERENCE_COLUMN]);
  }
}

/** Converts eval data in ADK's original format into an eval set. */
async function getEvalSetFromOldFormat(
  evalSetFile: string,
  evalConfig: EvalConfig,
  initialSession: Record<string, unknown>,
): Promise<EvalSet> {
  const datasets = await loadDataset(evalSetFile);
  if (datasets.length === 0) {
    throw new InputValidationError('The evaluation dataset is None or empty.');
  }
  const data = datasets[0];
  validateInput([data], evalConfig.criteria);
  return convertLegacyEvalSet(randomUUID(), [
    {name: evalSetFile, data, initialSession},
  ]);
}

/** Returns true when an error reports data that is not in the current schema. */
function isEvalSetSchemaError(err: unknown): boolean {
  return err instanceof Error && err.name === 'EvalSetSchemaError';
}

/**
 * Loads an eval set from a file, falling back to ADK's original format when
 * the file does not hold the current schema.
 *
 * A malformed JSON file surfaces its parse error rather than being read as
 * data in the original format.
 *
 * @throws {InputValidationError} When a current-schema file is combined with
 *   an explicit initial session.
 */
async function loadEvalSetFromFile(
  evalSetFile: string,
  evalConfig: EvalConfig,
  initialSession: Record<string, unknown>,
): Promise<EvalSet> {
  const info = await statOrUndefined(evalSetFile);
  if (info?.isFile()) {
    const raw: unknown = JSON.parse(await fs.readFile(evalSetFile, 'utf-8'));
    let evalSet: EvalSet | undefined;
    try {
      evalSet = parseEvalSet(raw);
    } catch (err: unknown) {
      if (!isEvalSetSchemaError(err)) {
        throw err;
      }
      logger.warn(
        `Contents of ${evalSetFile} appear to be in older format. To avoid ` +
          'this warning, please update your test files to contain data in ' +
          'EvalSet schema. You can use `migrateEvalDataToNewSchema` for ' +
          'migrating your old test files.',
      );
    }
    if (evalSet) {
      if (Object.keys(initialSession).length > 0) {
        throw new InputValidationError(
          'Initial session should be specified as a part of EvalSet file. ' +
            'Explicit initial session is only needed, when specifying data ' +
            'in the older schema.',
        );
      }
      return evalSet;
    }
  }
  return getEvalSetFromOldFormat(evalSetFile, evalConfig, initialSession);
}

/** Reads the session state every eval case of a run starts from. */
async function readInitialSession(
  initialSessionFile?: string,
): Promise<Record<string, unknown>> {
  if (!initialSessionFile) {
    return {};
  }
  const parsed: unknown = JSON.parse(
    await fs.readFile(initialSessionFile, 'utf-8'),
  );
  if (!isRecord(parsed)) {
    throw new InputValidationError(
      `Initial session file ${initialSessionFile} must hold a JSON object.`,
    );
  }
  return parsed;
}

/** Renders the text parts of a content as one string. */
function contentToText(content?: Content): string {
  return (content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => !!text)
    .join('\n');
}

/** Renders the tool calls of an invocation as one string, one call per line. */
function toolCallsToText(intermediateData?: IntermediateDataType): string {
  return getAllToolCalls(intermediateData)
    .map((toolCall) => JSON.stringify(toolCall))
    .join('\n');
}

/** Renders the columns shared by the detail table and the results CSV. */
function toDetailRow(
  result: EvalMetricResultWithInvocation,
  threshold: number,
): Record<string, unknown> {
  const {actualInvocation, expectedInvocation, evalMetricResult} = result;
  return {
    'eval_status': EvalStatus[evalMetricResult.evalStatus],
    'score': evalMetricResult.score,
    'threshold': threshold,
    'prompt': contentToText(
      (expectedInvocation ?? actualInvocation).userContent,
    ),
    'expected_response': contentToText(expectedInvocation?.finalResponse),
    'actual_response': contentToText(actualInvocation.finalResponse),
    'expected_tool_calls': toolCallsToText(
      expectedInvocation?.intermediateData,
    ),
    'actual_tool_calls': toolCallsToText(actualInvocation.intermediateData),
  };
}

/** Logs the verdict for one metric and the invocations behind it. */
function logDetails(
  results: readonly EvalMetricResultWithInvocation[],
  overallEvalStatus: EvalStatus,
  overallScore: number | undefined,
  metricName: string,
  threshold: number,
): void {
  logger.info(
    `Summary: \`${EvalStatus[overallEvalStatus]}\` for Metric: ` +
      `\`${metricName}\`. Expected threshold: \`${threshold}\`, actual ` +
      `value: \`${overallScore}\`.`,
  );
  const rows = results.map((result) => toDetailRow(result, threshold));
  logger.info(renderGridTable(rows, DETAIL_COLUMNS, MAX_DETAIL_COLUMN_WIDTH));
}

/**
 * Groups the metric results of one eval case by metric name.
 *
 * An eval case result holds metric results per invocation. This flips that
 * around, so that every result for one metric can be aggregated together.
 */
function groupMetricResultsByMetric(
  evalCaseResults: readonly EvalCaseResult[],
): Map<string, EvalMetricResultWithInvocation[]> {
  const byMetric = new Map<string, EvalMetricResultWithInvocation[]>();
  for (const evalCaseResult of evalCaseResults) {
    for (const perInvocation of evalCaseResult.evalMetricResultPerInvocation) {
      for (const evalMetricResult of perInvocation.evalMetricResults) {
        const results = byMetric.get(evalMetricResult.metricName) ?? [];
        results.push({
          actualInvocation: perInvocation.actualInvocation,
          expectedInvocation: perInvocation.expectedInvocation,
          evalMetricResult,
        });
        byMetric.set(evalMetricResult.metricName, results);
      }
    }
  }
  return byMetric;
}

/** Averages the scores of each metric and reports the ones that fall short. */
function processMetricsAndGetFailures(
  resultsByMetric: ReadonlyMap<string, EvalMetricResultWithInvocation[]>,
  printDetailedResults: boolean,
  agentModuleLabel: string,
): string[] {
  const failures: string[] = [];
  for (const [metricName, results] of resultsByMetric) {
    const threshold = getMetricThreshold(results[0].evalMetricResult);
    const scores = results
      .map((result) => result.evalMetricResult.score)
      .filter((score): score is number => score !== undefined);
    const overallScore =
      scores.length > 0
        ? scores.reduce((total, score) => total + score, 0) / scores.length
        : undefined;
    let overallEvalStatus = EvalStatus.NOT_EVALUATED;
    if (overallScore !== undefined) {
      overallEvalStatus =
        overallScore >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
    }

    if (overallEvalStatus !== EvalStatus.PASSED) {
      failures.push(
        `${metricName} for ${agentModuleLabel} Failed. Expected ` +
          `${threshold}, but got ${overallScore}.`,
      );
    }
    if (printDetailedResults) {
      logDetails(
        results,
        overallEvalStatus,
        overallScore,
        metricName,
        threshold,
      );
    }
  }
  return failures;
}

/**
 * Reports runs that failed without producing any metric result.
 *
 * A run whose inference crashed leaves the per-metric aggregation with nothing
 * to derive a verdict from, so the status on the eval case result is the only
 * record that the run failed.
 */
function getFailuresFromFinalEvalStatus(
  evalId: string,
  evalCaseResults: readonly EvalCaseResult[],
  agentModuleLabel: string,
): string[] {
  const failedRuns = evalCaseResults.filter(
    (result) =>
      result.finalEvalStatus === EvalStatus.FAILED &&
      !result.evalMetricResultPerInvocation.some(
        (perInvocation) => perInvocation.evalMetricResults.length > 0,
      ),
  ).length;

  if (failedRuns === 0) {
    return [];
  }
  return [
    `${evalId} for ${agentModuleLabel} Failed. ${failedRuns} of ` +
      `${evalCaseResults.length} runs were recorded as failed without ` +
      'producing any metric results.',
  ];
}

/** Flattens the results of one eval case into one row per metric result. */
function getResultsAsRows(
  evalSetId: string,
  evalId: string,
  resultsByMetric: ReadonlyMap<string, EvalMetricResultWithInvocation[]>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [metricName, results] of resultsByMetric) {
    for (const result of results) {
      rows.push({
        'eval_set_id': evalSetId,
        'eval_id': evalId,
        'metric_name': metricName,
        ...toDetailRow(result, getMetricThreshold(result.evalMetricResult)),
      });
    }
  }
  return rows;
}

/** Holds the eval set of one run, so that the eval service can read it. */
async function seedEvalSetsManager(
  appName: string,
  evalSet: EvalSet,
): Promise<EvalSetsManager> {
  const evalSetsManager = new InMemoryEvalSetsManager();
  await evalSetsManager.createEvalSet(appName, evalSet.evalSetId);
  for (const evalCase of evalSet.evalCases) {
    await evalSetsManager.addEvalCase(appName, evalSet.evalSetId, evalCase);
  }
  return evalSetsManager;
}

/** An evaluator for agents, mainly intended for helping with test cases. */
export class AgentEvaluator {
  /** Reads `test_config.json` from the folder holding the test file. */
  static async findConfigForTestFile(testFile: string): Promise<EvalConfig> {
    return getEvaluationCriteriaOrDefault(
      path.join(path.dirname(testFile), TEST_CONFIG_FILE),
    );
  }

  /**
   * Evaluates an agent against one eval set.
   *
   * @throws {InputValidationError} When the options are inconsistent, or when
   *   the results manager comes without an app name.
   * @throws {EvalFailureError} When a metric's mean score falls below its
   *   threshold, or when a run produced no metric results at all. Results are
   *   persisted before this is thrown.
   */
  static async evaluateEvalSet(options: EvaluateEvalSetOptions): Promise<void> {
    const {
      agentModule,
      evalSet,
      evalConfig,
      numRuns = NUM_RUNS,
      agentName,
      printDetailedResults = true,
      artifactService,
      outputFile,
      evalSetResultsManager,
    } = options;

    if (evalSetResultsManager !== undefined && !options.appName) {
      throw new InputValidationError(
        'app_name is required when eval_set_results_manager is provided.',
      );
    }

    const {agent, app} = await resolveAgentForEval(agentModule, agentName);
    const evalMetrics = getEvalMetricsFromConfig(evalConfig);
    const appName = options.appName ?? DEFAULT_APP_NAME;

    const evalService = getEvalRuntime().createEvalService({
      rootAgent: agent,
      app,
      evalSetsManager: await seedEvalSetsManager(appName, evalSet),
      evalConfig,
      artifactService,
      evalSetResultsManager,
    });

    const liveModelConfig = evalConfig.liveModelConfig;
    const inferenceConfig: InferenceConfig = liveModelConfig
      ? {useLive: true, liveTimeoutSeconds: liveModelConfig.timeoutSeconds}
      : {useLive: false};
    const inferenceResults: InferenceResult[] = [];
    for (let run = 0; run < numRuns; run++) {
      const inferences = evalService.performInference({
        appName,
        evalSetId: evalSet.evalSetId,
        inferenceConfig,
      });
      for await (const inferenceResult of inferences) {
        inferenceResults.push(inferenceResult);
      }
    }

    const evaluateRequest: EvaluateRequest = {
      inferenceResults,
      evaluateConfig: {evalMetrics},
    };
    const resultsByEvalId = new Map<string, EvalCaseResult[]>();
    for await (const evalResult of evalService.evaluate(evaluateRequest)) {
      const results = resultsByEvalId.get(evalResult.evalId) ?? [];
      results.push(evalResult);
      resultsByEvalId.set(evalResult.evalId, results);
    }

    const agentModuleLabel = describeAgentModule(agentModule);
    const failures: string[] = [];
    const csvRows: Array<Record<string, unknown>> = [];
    for (const [evalId, evalCaseResults] of resultsByEvalId) {
      const resultsByMetric = groupMetricResultsByMetric(evalCaseResults);
      failures.push(
        ...processMetricsAndGetFailures(
          resultsByMetric,
          printDetailedResults,
          agentModuleLabel,
        ),
        ...getFailuresFromFinalEvalStatus(
          evalId,
          evalCaseResults,
          agentModuleLabel,
        ),
      );
      if (outputFile) {
        csvRows.push(
          ...getResultsAsRows(evalSet.evalSetId, evalId, resultsByMetric),
        );
      }
    }

    if (outputFile) {
      await appendCsv(outputFile, csvRows, CSV_COLUMNS);
      logger.info(`Saved eval results to ${outputFile}`);
    }

    if (failures.length > 0) {
      let message = 'Following are all the test failures.';
      if (!printDetailedResults) {
        message +=
          ' If you are looking to get more details on the failures, then ' +
          'please re-run this test with `printDetailedResults` set to `true`.';
      }
      throw new EvalFailureError(`${message}\n${failures.join('\n')}`);
    }
  }

  /**
   * Evaluates an agent against every eval data file under a path.
   *
   * Test files are processed one at a time, so a directory of eval data does
   * not have to fit in memory at once.
   *
   * @throws {InputValidationError} When the options are inconsistent, or when
   *   the path names no eval data.
   * @throws {EvalFailureError} When a metric's mean score falls below its
   *   threshold.
   */
  static async evaluate(options: EvaluateOptions): Promise<void> {
    const {
      agentModule,
      evalDatasetFilePathOrDir,
      numRuns,
      agentName,
      initialSessionFile,
      printDetailedResults,
      artifactService,
      outputFile,
      appName,
      evalSetResultsManager,
    } = options;

    if (evalSetResultsManager !== undefined && !appName) {
      throw new InputValidationError(
        'app_name is required when eval_set_results_manager is provided.',
      );
    }

    const info = await statOrUndefined(evalDatasetFilePathOrDir);
    const testFiles = info?.isDirectory()
      ? await listTestFilesInDir(evalDatasetFilePathOrDir)
      : [evalDatasetFilePathOrDir];
    const initialSession = await readInitialSession(initialSessionFile);

    for (const testFile of testFiles) {
      const evalConfig = await AgentEvaluator.findConfigForTestFile(testFile);
      const evalSet = await loadEvalSetFromFile(
        testFile,
        evalConfig,
        initialSession,
      );
      await AgentEvaluator.evaluateEvalSet({
        agentModule,
        evalSet,
        evalConfig,
        numRuns,
        agentName,
        printDetailedResults,
        artifactService,
        outputFile,
        appName,
        evalSetResultsManager,
      });
    }
  }

  /** Rewrites eval data in ADK's original format as an eval set file. */
  static async migrateEvalDataToNewSchema(
    oldEvalDataFile: string,
    newEvalDataFile: string,
    initialSessionFile?: string,
  ): Promise<void> {
    if (!oldEvalDataFile || !newEvalDataFile) {
      throw new InputValidationError(
        'One of oldEvalDataFile or newEvalDataFile is empty.',
      );
    }
    const evalConfig =
      await AgentEvaluator.findConfigForTestFile(oldEvalDataFile);
    const initialSession = await readInitialSession(initialSessionFile);
    const evalSet = await getEvalSetFromOldFormat(
      oldEvalDataFile,
      evalConfig,
      initialSession,
    );
    await fs.writeFile(newEvalDataFile, serializeEvalSet(evalSet), 'utf-8');
  }
}
