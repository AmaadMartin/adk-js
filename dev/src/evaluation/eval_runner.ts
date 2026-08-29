/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseArtifactService,
  BaseSessionService,
  RunnableRoot,
} from '@google/adk';
import {randomUUID} from 'node:crypto';

import {getAbsolutePath, loadFileData} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {
  EVAL_SESSION_ID_PREFIX,
  EVAL_SET_FILE_SCHEMA,
  EvalMetric,
  EvalMetricResult,
  EvalResult,
  EvalSetItem,
  EvalStatus,
  EvalTurn,
  RESPONSE_MATCH_SCORE_KEY,
  ResetFunc,
  TOOL_TRAJECTORY_SCORE_KEY,
} from './eval_types.js';
import {processQueryWithRootAgent} from './evaluation_generator.js';
import {evaluateResponseMatch} from './response_evaluator.js';
import {evaluateTrajectory} from './trajectory_evaluator.js';

const logger = new AdkLogger({label: 'ADK Eval', colorize: {all: true}});

/** Options for {@link runEvals}. */
export interface RunEvalsOptions {
  /** Eval-set file to the case names to run from it; empty means all. */
  evalSetToEvals: Map<string, string[]>;
  rootAgent: RunnableRoot;
  /**
   * The app the agent file exported, when it exported one. Passing it keeps
   * the run's plugins and resumability config the same as `adk run` uses.
   */
  app?: App;
  resetFunc?: ResetFunc;
  evalMetrics: EvalMetric[];
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
  printDetailedResults?: boolean;
}

/**
 * Runs every selected eval case and returns one result per case.
 *
 * A case that throws is reported and skipped, so one broken case cannot abort
 * the run and contributes no result. A malformed eval-set file does throw:
 * none of its cases can run.
 */
export async function runEvals(
  options: RunEvalsOptions,
): Promise<EvalResult[]> {
  const warnedMetrics = new Set<string>();
  const evalResults: EvalResult[] = [];

  for (const [evalSetFile, evalsToRun] of options.evalSetToEvals) {
    const evalItems = await loadEvalSet(evalSetFile);

    for (const evalItem of evalItems) {
      if (evalsToRun.length > 0 && !evalsToRun.includes(evalItem.name)) {
        continue;
      }

      try {
        console.log(`Running Eval: ${evalSetFile}:${evalItem.name}`);
        const sessionId = `${EVAL_SESSION_ID_PREFIX}${randomUUID()}`;

        const turns = await processQueryWithRootAgent({
          data: evalItem.data,
          rootAgent: options.rootAgent,
          app: options.app,
          resetFunc: options.resetFunc,
          initialSession: evalItem.initial_session,
          sessionId,
          sessionService: options.sessionService,
          artifactService: options.artifactService,
        });

        const evalMetricResults: Array<[EvalMetric, EvalMetricResult]> = [];
        for (const evalMetric of options.evalMetrics) {
          const result = evaluateMetric(evalMetric, turns, {
            printDetailedResults: options.printDetailedResults,
            warnedMetrics,
          });
          evalMetricResults.push([evalMetric, result]);
          printEvalMetricResult(evalMetric, result);
        }

        const finalEvalStatus = foldFinalStatus(evalMetricResults);
        evalResults.push({
          evalSetFile,
          evalId: evalItem.name,
          finalEvalStatus,
          evalMetricResults,
          sessionId,
        });

        const verdict =
          finalEvalStatus === EvalStatus.PASSED ? '✅ Passed' : '❌ Failed';
        console.log(`Result: ${verdict}\n`);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        console.log(`Error: ${error.message}`);
        logger.debug(error.stack ?? error.message);
      }
    }
  }

  return evalResults;
}

async function loadEvalSet(evalSetFile: string): Promise<EvalSetItem[]> {
  const fileData = await loadFileData<unknown>(getAbsolutePath(evalSetFile));
  const parsed = EVAL_SET_FILE_SCHEMA.safeParse(fileData);
  if (!parsed.success) {
    throw new Error(
      `Invalid eval set file: ${evalSetFile}. Expected an array of ` +
        `{name, data} objects.`,
    );
  }
  if (parsed.data.length === 0) {
    throw new Error(`No eval data found in eval set file: ${evalSetFile}`);
  }

  return parsed.data;
}

interface EvaluateMetricOptions {
  printDetailedResults?: boolean;
  /** Metric names already warned about, so one warning covers the run. */
  warnedMetrics: Set<string>;
}

function evaluateMetric(
  evalMetric: EvalMetric,
  turns: EvalTurn[],
  options: EvaluateMetricOptions,
): EvalMetricResult {
  const score = scoreMetric(evalMetric.metricName, turns, options);
  if (score === undefined) {
    return {evalStatus: EvalStatus.NOT_EVALUATED};
  }

  return {
    score,
    evalStatus:
      score >= evalMetric.threshold ? EvalStatus.PASSED : EvalStatus.FAILED,
  };
}

/**
 * Scores one metric, or returns `undefined` when there is no score to report:
 * the metric has no scorer, or the eval data holds nothing for it to compare.
 */
function scoreMetric(
  metricName: string,
  turns: EvalTurn[],
  options: EvaluateMetricOptions,
): number | undefined {
  switch (metricName) {
    case TOOL_TRAJECTORY_SCORE_KEY:
      return evaluateTrajectory([turns], {
        printDetailedResults: options.printDetailedResults,
      });
    case RESPONSE_MATCH_SCORE_KEY:
      return evaluateResponseMatch(turns);
    default:
      warnUnsupportedMetric(metricName, options.warnedMetrics);
      return undefined;
  }
}

function warnUnsupportedMetric(
  metricName: string,
  warnedMetrics: Set<string>,
): void {
  if (warnedMetrics.has(metricName)) {
    return;
  }
  warnedMetrics.add(metricName);
  logger.warn(`\`${metricName}\` is not supported.`);
}

/**
 * Folds the per-metric verdicts into the case verdict: one failure fails the
 * case, an unevaluated metric abstains, and everything abstaining leaves the
 * case unevaluated.
 */
function foldFinalStatus(
  evalMetricResults: Array<[EvalMetric, EvalMetricResult]>,
): EvalStatus {
  let finalEvalStatus = EvalStatus.NOT_EVALUATED;

  for (const [, result] of evalMetricResults) {
    if (result.evalStatus === EvalStatus.FAILED) {
      return EvalStatus.FAILED;
    }
    if (result.evalStatus === EvalStatus.PASSED) {
      finalEvalStatus = EvalStatus.PASSED;
    }
  }

  return finalEvalStatus;
}

function printEvalMetricResult(
  evalMetric: EvalMetric,
  result: EvalMetricResult,
): void {
  console.log(
    `Metric: ${evalMetric.metricName}\tStatus: ${result.evalStatus}\t` +
      `Score: ${result.score ?? 'N/A'}\tThreshold: ${evalMetric.threshold}`,
  );
}
