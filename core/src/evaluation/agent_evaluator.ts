/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs a recorded eval dataset against an agent, from a test.
 *
 * `AgentEvaluator` holds no state: every behaviour is a module-level function
 * and the class is the entry point that adk-python users already know.
 */

import {Content} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {BaseAgent} from '../agents/base_agent.js';
import {App} from '../apps/app.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {appendCsv} from '../utils/csv_utils.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {formatTable} from '../utils/text_table_utils.js';
import {getAgentForEval} from './agent_module_loader.js';
import {InferenceConfig} from './base_eval_service.js';
import {
  getAllToolCalls,
  IntermediateDataType,
  Invocation,
} from './eval_case.js';
import {
  EvalConfig,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
} from './eval_config.js';
import {isEvalSetJson, parseEvalSet, serializeEvalSet} from './eval_json.js';
import {EvalMetricResult, EvalStatus, PrebuiltMetrics} from './eval_metrics.js';
import {EvalCaseResult} from './eval_result.js';
import {loadCreateEvalService} from './eval_runtime.js';
import {EvalSet} from './eval_set.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {InMemoryEvalSetsManager} from './in_memory_eval_sets_manager.js';
import {convertLegacyEvalSet} from './legacy_eval_set_converter.js';

/** How many times each eval case is run when the caller does not say. */
const NUM_RUNS = 2;

/** The app name used when no eval set results manager needs a real one. */
const DEFAULT_APP_NAME = 'test_app';

/** The file a folder's eval criteria are read from. */
const TEST_CONFIG_FILE = 'test_config.json';

/** The suffix that marks an eval data file inside a dataset directory. */
const TEST_FILE_SUFFIX = '.test.json';

/** Fields of one turn in the original eval data format. */
const QUERY_COLUMN = 'query';
const REFERENCE_COLUMN = 'reference';
const EXPECTED_TOOL_USE_COLUMN = 'expected_tool_use';

/** The metrics the original eval data format can be validated against. */
const ALLOWED_CRITERIA: readonly string[] = [
  PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
  PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
  PrebuiltMetrics.RESPONSE_MATCH_SCORE,
  PrebuiltMetrics.SAFETY_V1,
];

/** Columns of the printed detail table. */
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

/** Columns of the CSV output: the detail columns plus identifiers. */
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

/** A metric result together with the invocations it was computed from. */
interface EvalMetricResultWithInvocation {
  actualInvocation: Invocation;
  expectedInvocation?: Invocation;
  evalMetricResult: EvalMetricResult;
}

/** Options shared by {@link evaluate} and {@link evaluateEvalSet}. */
interface CommonEvaluateOptions {
  /**
   * Module specifier of the agent under test. It is imported, which runs its
   * top-level code, so it is trusted as far as the caller is.
   */
  agentModule: string;

  /** How many times to run each eval case. Defaults to 2. */
  numRuns?: number;

  /** Evaluates this sub-agent instead of the root agent. */
  agentName?: string;

  /** Whether to print a detail table per metric. Defaults to true. */
  printDetailedResults?: boolean;

  /** Loads artifacts during the run. */
  artifactService?: BaseArtifactService;

  /**
   * Writes per-invocation results to this path as CSV. Rows are appended, so
   * a dataset spread over several files produces one table.
   */
  outputFile?: string;

  /** The app name results are persisted under. Defaults to `test_app`. */
  appName?: string;

  /** Persists the run's results. Requires {@link appName}. */
  evalSetResultsManager?: EvalSetResultsManager;
}

/** Options for {@link AgentEvaluator.evaluateEvalSet}. */
export interface EvaluateEvalSetOptions extends CommonEvaluateOptions {
  evalSet: EvalSet;

  evalConfig: EvalConfig;
}

/** Options for {@link AgentEvaluator.evaluate}. */
export interface EvaluateOptions extends CommonEvaluateOptions {
  /**
   * An eval data file, or a directory searched for `*.test.json` files. Each
   * file is run against the `test_config.json` in its own folder.
   */
  evalDatasetFilePathOrDir: string;

  /** Session state shared by every case, for data in the original format. */
  initialSessionFile?: string;
}

/** Options for {@link AgentEvaluator.migrateEvalDataToNewSchema}. */
export interface MigrateEvalDataOptions {
  /** An eval data file in the original format. */
  oldEvalDataFile: string;

  /** Where to write the eval set. */
  newEvalDataFile: string;

  /** Session state to carry into the eval set. */
  initialSessionFile?: string;
}

function requireAppNameForResultsManager(options: CommonEvaluateOptions): void {
  if (options.evalSetResultsManager && !options.appName) {
    throw new InputValidationError(
      'appName is required when evalSetResultsManager is provided.',
    );
  }
}

/** Everything {@link getEvalResultsByEvalId} needs to run the eval service. */
interface EvalRunOptions {
  rootAgent: BaseAgent;
  app?: App;
  appName: string;
  evalSet: EvalSet;
  evalConfig: EvalConfig;
  numRuns: number;
  artifactService?: BaseArtifactService;
  evalSetResultsManager?: EvalSetResultsManager;
}

/**
 * Runs the eval set `numRuns` times and returns the results grouped by eval
 * case id, so that each metric can be averaged across the runs.
 */
async function getEvalResultsByEvalId(
  options: EvalRunOptions,
): Promise<Map<string, EvalCaseResult[]>> {
  const createEvalService = await loadCreateEvalService();
  const evalService = createEvalService({
    rootAgent: options.rootAgent,
    evalSetsManager: await buildEvalSetsManager(
      options.appName,
      options.evalSet,
    ),
    evalConfig: options.evalConfig,
    artifactService: options.artifactService,
    app: options.app,
    evalSetResultsManager: options.evalSetResultsManager,
  });

  const liveModelConfig = options.evalConfig.liveModelConfig;
  const inferenceConfig: InferenceConfig = liveModelConfig
    ? {useLive: true, liveTimeoutSeconds: liveModelConfig.timeoutSeconds}
    : {useLive: false};
  const inferenceRequest = {
    appName: options.appName,
    evalSetId: options.evalSet.evalSetId,
    inferenceConfig,
  };

  const inferenceResults = [];
  for (let run = 0; run < options.numRuns; run++) {
    for await (const result of evalService.performInference(inferenceRequest)) {
      inferenceResults.push(result);
    }
  }

  const resultsByEvalId = new Map<string, EvalCaseResult[]>();
  const evaluateRequest = {
    inferenceResults,
    evaluateConfig: {
      evalMetrics: getEvalMetricsFromConfig(options.evalConfig),
    },
  };
  for await (const result of evalService.evaluate(evaluateRequest)) {
    const forEvalId = resultsByEvalId.get(result.evalId) ?? [];
    forEvalId.push(result);
    resultsByEvalId.set(result.evalId, forEvalId);
  }
  return resultsByEvalId;
}

async function buildEvalSetsManager(
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

/**
 * Regroups results by metric name.
 *
 * An {@link EvalCaseResult} holds metric results per invocation; a verdict
 * needs every invocation's score for one metric, so this flips the nesting.
 */
function groupMetricResultsByMetric(
  resultsPerEvalId: readonly EvalCaseResult[],
): Map<string, EvalMetricResultWithInvocation[]> {
  const byMetric = new Map<string, EvalMetricResultWithInvocation[]>();
  for (const caseResult of resultsPerEvalId) {
    for (const perInvocation of caseResult.evalMetricResultPerInvocation) {
      for (const evalMetricResult of perInvocation.evalMetricResults) {
        const forMetric = byMetric.get(evalMetricResult.metricName) ?? [];
        forMetric.push({
          actualInvocation: perInvocation.actualInvocation,
          expectedInvocation: perInvocation.expectedInvocation,
          evalMetricResult,
        });
        byMetric.set(evalMetricResult.metricName, forMetric);
      }
    }
  }
  return byMetric;
}

/** Averages each metric's scores and returns a line per failing metric. */
function processMetricsAndGetFailures(
  metricResults: ReadonlyMap<string, EvalMetricResultWithInvocation[]>,
  printDetailedResults: boolean,
  agentModule: string,
): string[] {
  const failures: string[] = [];
  for (const [metricName, entries] of metricResults) {
    const threshold = entries[0].evalMetricResult.criterion.threshold;
    const scores = entries
      .map((entry) => entry.evalMetricResult.score)
      .filter((score): score is number => score !== undefined);
    const overallScore =
      scores.length > 0
        ? scores.reduce((total, score) => total + score, 0) / scores.length
        : undefined;
    const status = overallEvalStatus(overallScore, threshold);

    if (status !== EvalStatus.PASSED) {
      failures.push(
        `${metricName} for ${agentModule} Failed. Expected ${threshold}, ` +
          `but got ${overallScore}.`,
      );
    }
    if (printDetailedResults) {
      printDetails(entries, status, overallScore, metricName, threshold);
    }
  }
  return failures;
}

function overallEvalStatus(
  overallScore: number | undefined,
  threshold: number,
): EvalStatus {
  if (overallScore === undefined) {
    return EvalStatus.NOT_EVALUATED;
  }
  return overallScore >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
}

/**
 * Reports runs that failed without producing any metric result.
 *
 * A run whose inference crashed leaves {@link processMetricsAndGetFailures}
 * with nothing to judge, so the status on the eval case result is the only
 * record that it failed.
 */
function getFailuresFromFinalEvalStatus(
  evalId: string,
  resultsPerEvalId: readonly EvalCaseResult[],
  agentModule: string,
): string[] {
  const failedRuns = resultsPerEvalId.filter(
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
    `${evalId} for ${agentModule} Failed. ${failedRuns} of ` +
      `${resultsPerEvalId.length} runs were recorded as failed without ` +
      'producing any metric results.',
  ];
}

function buildFailureMessage(
  failures: readonly string[],
  printDetailedResults: boolean,
): string {
  const hint = printDetailedResults
    ? ''
    : ' If you looking to get more details on the failures, then please ' +
      're-run this test with `printDetailedResults` set to `true`.';
  return `Following are all the test failures.${hint}\n${failures.join('\n')}`;
}

/** Prints one metric's per-invocation results. */
function printDetails(
  entries: readonly EvalMetricResultWithInvocation[],
  status: EvalStatus,
  overallScore: number | undefined,
  metricName: string,
  threshold: number,
): void {
  const rows = entries.map((entry) => ({
    ...detailRow(entry),
    threshold,
  }));
  logger.info(
    `Summary: \`${EvalStatus[status]}\` for Metric: \`${metricName}\`. ` +
      `Expected threshold: \`${threshold}\`, actual value: ` +
      `\`${overallScore}\`.\n${formatTable(rows, DETAIL_COLUMNS)}`,
  );
}

/** The columns shared by the detail table and the CSV output. */
function detailRow(
  entry: EvalMetricResultWithInvocation,
): Record<string, unknown> {
  const {actualInvocation, expectedInvocation, evalMetricResult} = entry;
  return {
    eval_status: EvalStatus[evalMetricResult.evalStatus],
    score: evalMetricResult.score,
    prompt: contentToText(
      expectedInvocation
        ? expectedInvocation.userContent
        : actualInvocation.userContent,
    ),
    expected_response: contentToText(expectedInvocation?.finalResponse),
    actual_response: contentToText(actualInvocation.finalResponse),
    expected_tool_calls: toolCallsToText(expectedInvocation?.intermediateData),
    actual_tool_calls: toolCallsToText(actualInvocation.intermediateData),
  };
}

/** Flattens metric results into one row per metric per invocation. */
function getResultsAsRows(
  evalSetId: string,
  evalId: string,
  metricResults: ReadonlyMap<string, EvalMetricResultWithInvocation[]>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [metricName, entries] of metricResults) {
    for (const entry of entries) {
      rows.push({
        eval_set_id: evalSetId,
        eval_id: evalId,
        metric_name: metricName,
        threshold: entry.evalMetricResult.criterion.threshold,
        ...detailRow(entry),
      });
    }
  }
  return rows;
}

async function writeResultsToCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  outputFile: string,
): Promise<void> {
  await appendCsv(outputFile, rows, CSV_COLUMNS);
  logger.debug(`Saved eval results to ${outputFile}`);
}

function contentToText(content?: Content): string {
  return (content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join('\n');
}

function toolCallsToText(intermediateData?: IntermediateDataType): string {
  return getAllToolCalls(intermediateData)
    .map((toolCall) => JSON.stringify(toolCall))
    .join('\n');
}

/** Lists the eval data files the given path stands for. */
async function findTestFiles(pathOrDir: string): Promise<string[]> {
  if (!(await isDirectory(pathOrDir))) {
    return [pathOrDir];
  }
  const names = await fs.readdir(pathOrDir, {recursive: true});
  return names
    .filter((name) => name.endsWith(TEST_FILE_SUFFIX))
    .map((name) => path.join(pathOrDir, name))
    .sort();
}

async function isDirectory(candidate: string): Promise<boolean> {
  const stats = await fs.stat(candidate).catch(() => undefined);
  return stats?.isDirectory() ?? false;
}

/**
 * Loads an eval set from a file, falling back to the original eval data
 * format when the file is not an eval set.
 */
async function loadEvalSetFromFile(
  evalSetFile: string,
  evalConfig: EvalConfig,
  initialSession: Record<string, unknown>,
): Promise<EvalSet> {
  const raw = await readJsonIfFile(evalSetFile);
  if (isEvalSetJson(raw)) {
    if (Object.keys(initialSession).length > 0) {
      throw new InputValidationError(
        'Initial session should be specified as a part of EvalSet file. ' +
          'Explicit initial session is only needed, when specifying data in ' +
          'the older schema.',
      );
    }
    return parseEvalSet(raw);
  }
  if (raw !== undefined) {
    logger.warn(
      `Contents of ${evalSetFile} appear to be in the older format. To ` +
        'avoid this warning, update your test files to hold data in the ' +
        'EvalSet schema. `AgentEvaluator.migrateEvalDataToNewSchema` ' +
        'converts them.',
    );
  }
  return getEvalSetFromLegacyFormat(evalSetFile, evalConfig, initialSession);
}

/** Reads and parses the file, or returns undefined when it is not a file. */
async function readJsonIfFile(filePath: string): Promise<unknown> {
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile()) {
    return undefined;
  }
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

async function getEvalSetFromLegacyFormat(
  evalSetFile: string,
  evalConfig: EvalConfig,
  initialSession: Record<string, unknown>,
): Promise<EvalSet> {
  const data = await loadLegacyDataset(evalSetFile);
  validateLegacyDataset(data, evalConfig.criteria);
  return convertLegacyEvalSet(randomUUID(), [
    {name: evalSetFile, data, initialSession},
  ]);
}

async function getInitialSession(
  initialSessionFile?: string,
): Promise<Record<string, unknown>> {
  if (!initialSessionFile) {
    return {};
  }
  const parsed: unknown = JSON.parse(
    await fs.readFile(initialSessionFile, 'utf-8'),
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InputValidationError(
      `${initialSessionFile} must contain a JSON object.`,
    );
  }
  return {...parsed};
}

/** Reads one eval data file in the original format. */
async function loadLegacyDataset(
  inputPath: string,
): Promise<Array<Record<string, unknown>>> {
  const stats = await fs.stat(inputPath).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new InputValidationError(`Input path ${inputPath} is invalid.`);
  }
  const parsed: unknown = JSON.parse(await fs.readFile(inputPath, 'utf-8'));
  if (!Array.isArray(parsed) || !parsed.every(isPlainRecord)) {
    throw new InputValidationError(
      `${inputPath} must contain a list of dictionaries.`,
    );
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks that the criteria can be judged from the data.
 *
 * Only the first turn is inspected, which is what adk-python does and is
 * enough to catch a dataset that is missing a whole column.
 */
function validateLegacyDataset(
  data: ReadonlyArray<Record<string, unknown>>,
  criteria: Readonly<Record<string, unknown>>,
): void {
  if (data.length === 0) {
    throw new InputValidationError('The evaluation dataset is empty.');
  }
  for (const key of Object.keys(criteria)) {
    if (!ALLOWED_CRITERIA.includes(key)) {
      throw new InputValidationError(
        `Invalid criteria key: ${key}. Expected one of ` +
          `${ALLOWED_CRITERIA.join(', ')}.`,
      );
    }
  }
  const sample = data[0];
  const required: Array<[PrebuiltMetrics, string[]]> = [
    [
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      [QUERY_COLUMN, EXPECTED_TOOL_USE_COLUMN],
    ],
    [PrebuiltMetrics.RESPONSE_EVALUATION_SCORE, [QUERY_COLUMN]],
    [PrebuiltMetrics.RESPONSE_MATCH_SCORE, [QUERY_COLUMN, REFERENCE_COLUMN]],
  ];
  for (const [metric, columns] of required) {
    if (criteria[metric] === undefined) {
      continue;
    }
    if (columns.some((column) => !(column in sample))) {
      const named = columns.map((column) => `'${column}'`).join(' and ');
      throw new InputValidationError(
        `Samples for ${metric} must include ${named} keys. The sample is ` +
          `${JSON.stringify(data)}.`,
      );
    }
  }
}

/** Evaluates agents against recorded eval data, from a test. */
export class AgentEvaluator {
  /** Reads the eval config from the test file's own folder. */
  static async findConfigForTestFile(testFile: string): Promise<EvalConfig> {
    return getEvaluationCriteriaOrDefault(
      path.join(path.dirname(testFile), TEST_CONFIG_FILE),
    );
  }

  /**
   * Runs one eval set against an agent and throws when a metric falls below
   * its threshold.
   */
  static async evaluateEvalSet(options: EvaluateEvalSetOptions): Promise<void> {
    requireAppNameForResultsManager(options);
    const {agent, app} = await getAgentForEval(
      options.agentModule,
      options.agentName,
    );
    const appName = options.appName ?? DEFAULT_APP_NAME;
    const printDetailedResults = options.printDetailedResults ?? true;

    const resultsByEvalId = await getEvalResultsByEvalId({
      rootAgent: agent,
      app,
      appName,
      evalSet: options.evalSet,
      evalConfig: options.evalConfig,
      numRuns: options.numRuns ?? NUM_RUNS,
      artifactService: options.artifactService,
      evalSetResultsManager: options.evalSetResultsManager,
    });

    const failures: string[] = [];
    const csvRows: Array<Record<string, unknown>> = [];
    for (const [evalId, resultsPerEvalId] of resultsByEvalId) {
      const metricResults = groupMetricResultsByMetric(resultsPerEvalId);
      failures.push(
        ...processMetricsAndGetFailures(
          metricResults,
          printDetailedResults,
          options.agentModule,
        ),
        ...getFailuresFromFinalEvalStatus(
          evalId,
          resultsPerEvalId,
          options.agentModule,
        ),
      );
      if (options.outputFile) {
        csvRows.push(
          ...getResultsAsRows(options.evalSet.evalSetId, evalId, metricResults),
        );
      }
    }

    if (options.outputFile) {
      await writeResultsToCsv(csvRows, options.outputFile);
    }
    if (failures.length > 0) {
      throw new Error(buildFailureMessage(failures, printDetailedResults));
    }
  }

  /**
   * Runs every `*.test.json` under the given path against an agent.
   *
   * Each file is evaluated with the config found in its own folder, so one
   * call can cover folders with different criteria.
   */
  static async evaluate(options: EvaluateOptions): Promise<void> {
    requireAppNameForResultsManager(options);
    const testFiles = await findTestFiles(options.evalDatasetFilePathOrDir);
    const initialSession = await getInitialSession(options.initialSessionFile);

    for (const testFile of testFiles) {
      const evalConfig = await AgentEvaluator.findConfigForTestFile(testFile);
      const evalSet = await loadEvalSetFromFile(
        testFile,
        evalConfig,
        initialSession,
      );
      await AgentEvaluator.evaluateEvalSet({
        agentModule: options.agentModule,
        evalSet,
        evalConfig,
        numRuns: options.numRuns,
        agentName: options.agentName,
        printDetailedResults: options.printDetailedResults,
        artifactService: options.artifactService,
        outputFile: options.outputFile,
        appName: options.appName,
        evalSetResultsManager: options.evalSetResultsManager,
      });
    }
  }

  /** Converts an eval data file in the original format to an eval set file. */
  static async migrateEvalDataToNewSchema(
    options: MigrateEvalDataOptions,
  ): Promise<void> {
    if (!options.oldEvalDataFile || !options.newEvalDataFile) {
      throw new InputValidationError(
        'One of oldEvalDataFile or newEvalDataFile is empty.',
      );
    }
    const evalConfig = await AgentEvaluator.findConfigForTestFile(
      options.oldEvalDataFile,
    );
    const initialSession = await getInitialSession(options.initialSessionFile);
    const evalSet = await getEvalSetFromLegacyFormat(
      options.oldEvalDataFile,
      evalConfig,
      initialSession,
    );
    await fs.writeFile(
      options.newEvalDataFile,
      serializeEvalSet(evalSet),
      'utf-8',
    );
  }
}
