/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  BaseSessionService,
  RunnableRoot,
} from '@google/adk';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

import {EvalSetItem, EvalTurn} from '../evaluation/evaluation_constants.js';
import {processQueryWithRootAgent} from '../evaluation/evaluation_generator.js';
import {evaluateTrajectory} from '../evaluation/trajectory_evaluator.js';
import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {getAbsolutePath, loadFileData} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'ADK Eval', colorize: {all: true}});

/**
 * The verdict for one metric, or for a whole eval case.
 *
 * The values are the words adk-python prints, so a console transcript reads
 * the same in both SDKs.
 */
export enum EvalStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NOT_EVALUATED = 'NOT_EVALUATED',
}

/** One metric the run scores, and the score it has to reach to pass. */
export interface EvalMetric {
  metricName: string;
  threshold: number;
}

/** What one metric scored on one eval case. */
export interface EvalMetricResult {
  /** Absent when the metric was not evaluated. */
  score?: number;
  evalStatus: EvalStatus;
}

/** The outcome of one eval case. */
export interface EvalResult {
  evalSetFile: string;
  evalId: string;
  finalEvalStatus: EvalStatus;
  evalMetricResults: Array<[EvalMetric, EvalMetricResult]>;
  sessionId: string;
}

/** The one metric this command scores. */
export const TOOL_TRAJECTORY_SCORE_KEY = 'tool_trajectory_avg_score';

/** Scored by adk-python with ROUGE, which adk-js has no counterpart for. */
export const RESPONSE_MATCH_SCORE_KEY = 'response_match_score';

/** Prefix of every session an eval case runs in. */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/** The criteria used when no config file is supplied. */
export const DEFAULT_CRITERIA: Readonly<Record<string, number>> = {
  [TOOL_TRAJECTORY_SCORE_KEY]: 1.0,
  [RESPONSE_MATCH_SCORE_KEY]: 0.8,
};

const SUMMARY_SEPARATOR = '*'.repeat(69);

/** Shape of a criteria file: `{"criteria": {"<metric>": <threshold>}}`. */
const CRITERIA_FILE_SCHEMA = z.object({
  criteria: z.record(z.string(), z.number().finite()),
});

const EXPECTED_TOOL_USE_SCHEMA = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  mock_tool_output: z.unknown().optional(),
});

const EVAL_TURN_SCHEMA = z.object({
  query: z.string(),
  expected_tool_use: z.array(EXPECTED_TOOL_USE_SCHEMA).optional(),
  reference: z.string().nullish(),
});

const EVAL_SET_FILE_SCHEMA = z.array(
  z.object({
    name: z.string(),
    data: z.array(EVAL_TURN_SCHEMA),
    initial_session: z
      .object({
        app_name: z.string().optional(),
        user_id: z.string().optional(),
        state: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
);

/** A hook an agent file exports to clear its own state before a case runs. */
export type ResetFunc = () => void | Promise<void>;

/** Options for {@link runEvals}. */
export interface RunEvalsOptions {
  /** Eval-set file to the case names to run from it; empty means all. */
  evalSetToEvals: Map<string, string[]>;
  rootAgent: RunnableRoot;
  resetFunc?: ResetFunc;
  evalMetrics: EvalMetric[];
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
  printDetailedResults?: boolean;
}

/** Options for {@link evalAgent}. */
export interface EvalAgentOptions {
  /** Agent file path, the same contract `adk run` takes. */
  agentPath: string;
  /** Each entry is `<path>` or `<path>:case1,case2`. */
  evalSetFilePaths: string[];
  configFilePath?: string;
  printDetailedResults?: boolean;
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
  agentFileLoadOptions?: AgentFileOptions;
}

/**
 * Splits each `<eval set>[:case1,case2]` input into the eval set and the case
 * names to run from it.
 *
 * A Windows drive letter is not a selector separator, so the search for `:`
 * starts after it. Listing one eval set twice accumulates its selectors. The
 * result is a `Map` so insertion order is kept and a case named `__proto__`
 * cannot collide with an object prototype key.
 */
export function parseAndGetEvalsToRun(inputs: string[]): Map<string, string[]> {
  const evalSetToEvals = new Map<string, string[]>();

  for (const input of inputs) {
    const separatorIndex = input.indexOf(
      ':',
      hasWindowsDrivePrefix(input) ? 3 : 0,
    );
    const evalSet =
      separatorIndex === -1 ? input : input.slice(0, separatorIndex);
    const selectors =
      separatorIndex === -1
        ? []
        : parseSelectors(input.slice(separatorIndex + 1));

    const existing = evalSetToEvals.get(evalSet);
    if (existing) {
      existing.push(...selectors);
    } else {
      evalSetToEvals.set(evalSet, selectors);
    }
  }

  return evalSetToEvals;
}

function hasWindowsDrivePrefix(input: string): boolean {
  return (
    input.length >= 3 &&
    /^[A-Za-z]$/.test(input[0]) &&
    input[1] === ':' &&
    (input[2] === '\\' || input[2] === '/')
  );
}

/** Everything up to a further `:`, split on commas, blanks dropped. */
function parseSelectors(selectorList: string): string[] {
  return selectorList
    .split(':')[0]
    .split(',')
    .filter((selector) => selector.trim() !== '');
}

/**
 * Reads the criteria from `configFilePath`.
 *
 * Supplying no path is not an error: it selects {@link DEFAULT_CRITERIA}. A
 * path that names an unreadable or malformed file is an error.
 */
export async function getEvaluationCriteriaOrDefault(
  configFilePath?: string,
): Promise<Record<string, number>> {
  if (!configFilePath) {
    logger.info('No config file supplied. Using default criteria.');
    return DEFAULT_CRITERIA;
  }

  const configData = await loadFileData<unknown>(
    getAbsolutePath(configFilePath),
  );
  const parsed = CRITERIA_FILE_SCHEMA.safeParse(configData);
  if (!parsed.success) {
    throw new Error(
      `Invalid format for ${configFilePath}. Expected a 'criteria' object ` +
        `mapping each metric name to a finite number.`,
    );
  }

  return parsed.data.criteria;
}

/**
 * Returns the agent file's `resetData` export, when it exports one.
 *
 * adk-python looks up `reset_data`; the adk-js agent-file contract is already
 * camelCase (`rootAgent`, `app`), so `resetData` is the consistent spelling.
 */
export function tryGetResetFunc(agentFile: AgentFile): ResetFunc | undefined {
  const resetData = agentFile.moduleExports?.['resetData'];
  return isResetFunc(resetData) ? resetData : undefined;
}

/**
 * Narrows an arbitrary export to a reset hook.
 *
 * Only callability is checkable at runtime; an exported `resetData` that takes
 * arguments still passes and is called with none.
 */
function isResetFunc(value: unknown): value is ResetFunc {
  return typeof value === 'function';
}

/**
 * Runs every selected eval case and yields one result per case.
 *
 * A case that throws is reported and skipped, so one broken case cannot abort
 * the run. A malformed eval-set file does throw: none of its cases can run.
 */
export async function* runEvals(
  options: RunEvalsOptions,
): AsyncGenerator<EvalResult> {
  const warnedMetrics = new Set<string>();

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
        yield {
          evalSetFile,
          evalId: evalItem.name,
          finalEvalStatus,
          evalMetricResults,
          sessionId,
        };

        const verdict =
          finalEvalStatus === EvalStatus.PASSED ? '✅ Passed' : '❌ Failed';
        console.log(`Result: ${verdict}\n`);
      } catch (e) {
        const error = toError(e);
        console.log(`Error: ${error.message}`);
        logger.debug(error.stack ?? error.message);
      }
    }
  }
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
  if (evalMetric.metricName !== TOOL_TRAJECTORY_SCORE_KEY) {
    warnUnsupportedMetric(evalMetric.metricName, options.warnedMetrics);
    return {evalStatus: EvalStatus.NOT_EVALUATED};
  }

  const score = evaluateTrajectory([turns], {
    printDetailedResults: options.printDetailedResults,
  });
  return {
    score,
    evalStatus:
      score >= evalMetric.threshold ? EvalStatus.PASSED : EvalStatus.FAILED,
  };
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

/** Prints the pass and fail counts of each eval-set file. */
export function printEvalSummary(evalResults: EvalResult[]): void {
  const summary = new Map<string, {passed: number; failed: number}>();

  for (const evalResult of evalResults) {
    const counts = summary.get(evalResult.evalSetFile) ?? {
      passed: 0,
      failed: 0,
    };
    if (evalResult.finalEvalStatus === EvalStatus.PASSED) {
      counts.passed++;
    } else {
      counts.failed++;
    }
    summary.set(evalResult.evalSetFile, counts);
  }

  console.log(SUMMARY_SEPARATOR);
  console.log('Eval Run Summary');
  for (const [evalSetFile, counts] of summary) {
    console.log(
      `${evalSetFile}:\n  Tests passed: ${counts.passed}\n` +
        `  Tests failed: ${counts.failed}`,
    );
  }
}

/** Loads the agent, runs every selected eval case, and prints the summary. */
export async function evalAgent(options: EvalAgentOptions): Promise<void> {
  const evaluationCriteria = await getEvaluationCriteriaOrDefault(
    options.configFilePath,
  );
  const evalMetrics: EvalMetric[] = Object.entries(evaluationCriteria).map(
    ([metricName, threshold]) => ({metricName, threshold}),
  );
  console.log(
    `Using evaluation criteria: ${JSON.stringify(evaluationCriteria)}`,
  );

  await using agentFile = new AgentFile(
    getAbsolutePath(options.agentPath),
    options.agentFileLoadOptions,
  );
  const rootAgent = await agentFile.loadAgent();
  const resetFunc = tryGetResetFunc(agentFile);

  const evalResults: EvalResult[] = [];
  for await (const evalResult of runEvals({
    evalSetToEvals: parseAndGetEvalsToRun(options.evalSetFilePaths),
    rootAgent,
    resetFunc,
    evalMetrics,
    sessionService: options.sessionService,
    artifactService: options.artifactService,
    printDetailedResults: options.printDetailedResults,
  })) {
    evalResults.push(evalResult);
  }

  printEvalSummary(evalResults);
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
