/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {BaseAgent} from '../agents/base_agent.js';
import {logger} from '../utils/logger.js';

import {EvalFailureError} from './errors.js';
import {EvalCase} from './eval_case.js';
import {
  CriterionBackedEvalMetric,
  EvalConfig,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
} from './eval_config.js';
import {
  loadEvalSetFromFile,
  readInitialSessionFile,
  toEvalSetJson,
} from './eval_data_loader.js';
import {EvalStatus} from './eval_metrics.js';
import {formatMetricDetails} from './eval_report.js';
import {EvalSet} from './eval_set.js';
import {EvaluationGenerator} from './evaluation_generator.js';
import {PerInvocationResult} from './evaluator.js';
import {getDefaultMetricEvaluatorRegistry} from './metric_evaluator_registry.js';
import {StaticUserSimulator} from './simulation/static_user_simulator.js';

/** Suffix that marks a file as an eval dataset. */
const TEST_FILE_SUFFIX = '.test.json';

/** Name of the config file read from the eval file's own directory. */
const TEST_CONFIG_FILE_NAME = 'test_config.json';

/** Default number of times every eval case is run before scoring. */
export const NUM_RUNS = 2;

/** Options shared by every entry point of {@link AgentEvaluator}. */
export interface EvaluateBaseOptions {
  /** The agent under test. */
  agent: BaseAgent;
  /** Times to run every eval case. Defaults to {@link NUM_RUNS}. */
  numRuns?: number;
  /** Evaluate a named sub-agent instead of the root. */
  agentName?: string;
  /** Include the per-invocation detail in the failure report. Defaults to true. */
  printDetailedResults?: boolean;
}

/** Options for {@link AgentEvaluator.evaluate}. */
export interface EvaluateOptions extends EvaluateBaseOptions {
  /** A `*.test.json` file, or a directory searched recursively for them. */
  evalDatasetFilePathOrDir: string;
  /** JSON file holding session values shared by every case in the dataset. */
  initialSessionFile?: string;
}

/** Options for {@link AgentEvaluator.evaluateEvalSet}. */
export interface EvaluateEvalSetOptions extends EvaluateBaseOptions {
  /** The eval set to run. */
  evalSet: EvalSet;
  /** The criteria every eval case in the set is scored against. */
  evalConfig: EvalConfig;
}

/** Returns every `*.test.json` file at or below `pathOrDir`. */
function collectTestFiles(pathOrDir: string): string[] {
  if (!fs.existsSync(pathOrDir)) {
    throw new Error(`Input path ${pathOrDir} is invalid.`);
  }
  if (!fs.statSync(pathOrDir).isDirectory()) {
    return [pathOrDir];
  }

  const testFiles: string[] = [];
  for (const entry of fs.readdirSync(pathOrDir, {withFileTypes: true})) {
    const entryPath = path.join(pathOrDir, entry.name);
    if (entry.isDirectory()) {
      testFiles.push(...collectTestFiles(entryPath));
    } else if (entry.name.endsWith(TEST_FILE_SUFFIX)) {
      testFiles.push(entryPath);
    }
  }
  return testFiles;
}

/** Resolves the agent to evaluate, honouring an explicit sub-agent name. */
function resolveAgent(agent: BaseAgent, agentName?: string): BaseAgent {
  if (!agentName) {
    return agent;
  }
  const subAgent = agent.findAgent(agentName);
  if (!subAgent) {
    throw new Error(`Sub-Agent '${agentName}' not found.`);
  }
  return subAgent;
}

/** Every per-invocation result recorded for one metric. */
interface MetricResults {
  evalMetric: CriterionBackedEvalMetric;
  results: PerInvocationResult[];
}

/**
 * Runs one eval case `numRuns` times and returns every per-invocation result,
 * grouped by metric.
 */
async function scoreEvalCase(
  agent: BaseAgent,
  evalCase: EvalCase,
  evalMetrics: CriterionBackedEvalMetric[],
  numRuns: number,
): Promise<MetricResults[]> {
  const expectedInvocations = evalCase.conversation;
  if (expectedInvocations === undefined) {
    throw new Error(
      `Eval case '${evalCase.evalId}' has no conversation. AgentEvaluator` +
        ' only supports eval cases with a recorded conversation.',
    );
  }

  const metricResults: MetricResults[] = evalMetrics.map((evalMetric) => ({
    evalMetric,
    results: [],
  }));

  for (let run = 0; run < numRuns; run++) {
    const actualInvocations =
      await EvaluationGenerator.generateInferencesFromRootAgent({
        rootAgent: agent,
        userSimulator: new StaticUserSimulator(expectedInvocations),
        initialSession: evalCase.sessionInput,
      });

    for (const metricResult of metricResults) {
      const evaluator = getDefaultMetricEvaluatorRegistry().getEvaluator(
        metricResult.evalMetric,
      );
      const evaluationResult = await evaluator.evaluateInvocations(
        actualInvocations,
        expectedInvocations,
      );
      metricResult.results.push(...evaluationResult.perInvocationResults);
    }
  }
  return metricResults;
}

/**
 * Averages each metric's scores across every run and returns one failure line
 * per metric that did not pass, preceded by its detail when requested.
 */
function collectFailures(
  metricResults: MetricResults[],
  agentName: string,
  printDetailedResults: boolean,
): string[] {
  const failures: string[] = [];
  for (const {evalMetric, results} of metricResults) {
    if (results.length === 0) {
      continue;
    }
    const threshold = evalMetric.criterion.threshold;

    const scores = results
      .map((result) => result.score)
      .filter((score): score is number => score !== undefined);
    const overallScore =
      scores.length > 0
        ? scores.reduce((total, score) => total + score, 0) / scores.length
        : undefined;
    const overallEvalStatus =
      overallScore === undefined
        ? EvalStatus.NOT_EVALUATED
        : overallScore >= threshold
          ? EvalStatus.PASSED
          : EvalStatus.FAILED;

    if (overallEvalStatus === EvalStatus.PASSED) {
      continue;
    }

    const details = formatMetricDetails(
      evalMetric.metricName,
      threshold,
      overallScore,
      overallEvalStatus,
      results,
    );
    logger.debug(details);
    if (printDetailedResults) {
      failures.push(details);
    }
    failures.push(
      `${evalMetric.metricName} for ${agentName} Failed. Expected` +
        ` ${threshold}, but got ${overallScore ?? 'none'}.`,
    );
  }
  return failures;
}

/**
 * Runs an agent against recorded eval data and fails the caller's test when a
 * metric scores below its threshold.
 *
 * Unlike adk-python, which imports the agent from a module path, the agent is
 * passed in directly: TypeScript has no `root_agent` module convention.
 */
export class AgentEvaluator {
  /** Reads the `test_config.json` sitting next to `testFile`. */
  static findConfigForTestFile(testFile: string): EvalConfig {
    return getEvaluationCriteriaOrDefault(
      path.join(path.dirname(testFile), TEST_CONFIG_FILE_NAME),
    );
  }

  /**
   * Evaluates an agent against the eval data at `evalDatasetFilePathOrDir`.
   *
   * @throws {EvalFailureError} If any metric scores below its threshold.
   */
  static async evaluate(options: EvaluateOptions): Promise<void> {
    const testFiles = collectTestFiles(options.evalDatasetFilePathOrDir);
    const initialSession = readInitialSessionFile(options.initialSessionFile);

    for (const testFile of testFiles) {
      const evalConfig = AgentEvaluator.findConfigForTestFile(testFile);
      await AgentEvaluator.evaluateEvalSet({
        agent: options.agent,
        evalSet: loadEvalSetFromFile(testFile, evalConfig, initialSession),
        evalConfig,
        numRuns: options.numRuns,
        agentName: options.agentName,
        printDetailedResults: options.printDetailedResults,
      });
    }
  }

  /**
   * Evaluates an agent against an already-loaded {@link EvalSet}.
   *
   * @throws {EvalFailureError} If any metric scores below its threshold. Every
   *     failing metric across every eval case is reported, not just the first.
   */
  static async evaluateEvalSet({
    agent,
    evalSet,
    evalConfig,
    numRuns = NUM_RUNS,
    agentName,
    printDetailedResults = true,
  }: EvaluateEvalSetOptions): Promise<void> {
    const agentForEval = resolveAgent(agent, agentName);
    const evalMetrics = getEvalMetricsFromConfig(evalConfig);

    const failures: string[] = [];
    for (const evalCase of evalSet.evalCases) {
      const metricResults = await scoreEvalCase(
        agentForEval,
        evalCase,
        evalMetrics,
        numRuns,
      );
      failures.push(
        ...collectFailures(
          metricResults,
          agentForEval.name,
          printDetailedResults,
        ),
      );
    }

    if (failures.length === 0) {
      return;
    }

    let message = 'Following are all the test failures.';
    if (!printDetailedResults) {
      message +=
        ' If you are looking to get more details on the failures, then' +
        ' please re-run this test with `printDetailedResults` set to `true`.';
    }
    throw new EvalFailureError(`${message}\n${failures.join('\n')}`);
  }

  /**
   * Rewrites a legacy-format eval file as an {@link EvalSet} JSON file that
   * both adk-js and adk-python can read.
   *
   * @throws {Error} If either path is empty.
   */
  static migrateEvalDataToNewSchema(
    oldEvalDataFile: string,
    newEvalDataFile: string,
    initialSessionFile?: string,
  ): void {
    if (!oldEvalDataFile || !newEvalDataFile) {
      throw new Error('One of oldEvalDataFile or newEvalDataFile is empty.');
    }

    const evalSet = loadEvalSetFromFile(
      oldEvalDataFile,
      AgentEvaluator.findConfigForTestFile(oldEvalDataFile),
      readInitialSessionFile(initialSessionFile),
    );
    fs.writeFileSync(newEvalDataFile, toEvalSetJson(evalSet), 'utf-8');
  }
}
