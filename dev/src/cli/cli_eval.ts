/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseArtifactService, BaseSessionService, isApp} from '@google/adk';

import {runEvals} from '../evaluation/eval_runner.js';
import {
  CRITERIA_FILE_SCHEMA,
  DEFAULT_CRITERIA,
  EvalMetric,
  EvalResult,
  EvalStatus,
  ResetFunc,
} from '../evaluation/eval_types.js';
import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {getAbsolutePath, loadFileData} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'ADK Eval', colorize: {all: true}});

const SUMMARY_SEPARATOR = '*'.repeat(69);

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
 * starts after it. The result is a `Map` so insertion order is kept and a case
 * named `__proto__` cannot collide with an object prototype key.
 *
 * Listing one eval set twice accumulates its selectors, which narrows an
 * unselected entry: `['f.json', 'f.json:case_1']` runs only `case_1`, not
 * every case. adk-python's `extend` on a `defaultdict(list)` does the same.
 */
export function parseAndGetEvalsToRun(inputs: string[]): Map<string, string[]> {
  const evalSetToEvals = new Map<string, string[]>();

  for (const input of inputs) {
    // A leading `C:\` or `C:/` is a drive letter, not a selector separator.
    const searchFrom = /^[A-Za-z]:[\\/]/.test(input) ? 2 : 0;
    const separatorIndex = input.indexOf(':', searchFrom);
    const evalSet =
      separatorIndex === -1 ? input : input.slice(0, separatorIndex);
    const selectors =
      separatorIndex === -1
        ? []
        : parseSelectors(input.slice(separatorIndex + 1));

    evalSetToEvals.set(evalSet, [
      ...(evalSetToEvals.get(evalSet) ?? []),
      ...selectors,
    ]);
  }

  return evalSetToEvals;
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
    // A copy: the return type is mutable, so handing back the constant itself
    // would let a caller edit it for the rest of the process.
    return {...DEFAULT_CRITERIA};
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
 * `typeof x === 'function'` narrows `unknown` only to `Function`, so a
 * predicate is what keeps a cast out of the caller. Callability is all that is
 * checkable: a `resetData` declared with arguments passes and is called with
 * none.
 */
function isResetFunc(value: unknown): value is ResetFunc {
  return typeof value === 'function';
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
  const loaded = await agentFile.load();
  const app = isApp(loaded) ? loaded : undefined;
  const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;

  const evalResults = await runEvals({
    evalSetToEvals: parseAndGetEvalsToRun(options.evalSetFilePaths),
    rootAgent,
    app,
    resetFunc: tryGetResetFunc(agentFile),
    evalMetrics,
    sessionService: options.sessionService,
    artifactService: options.artifactService,
    printDetailedResults: options.printDetailedResults,
  });

  printEvalSummary(evalResults);
}
