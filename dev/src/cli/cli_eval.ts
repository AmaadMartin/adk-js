/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `adk eval`: scores an agent against one or more eval sets.
 *
 * A port of adk-python's `cli_eval` command in `cli/cli_tools_click.py`. The
 * eval service itself is not part of this build of `@google/adk`; the command
 * asks {@link getEvalRuntime} for it and reports the missing-runtime message
 * when nothing has installed one.
 */

import {
  App,
  BaseAgent,
  createGcsEvalManagersFromUri,
  EvalCaseResult,
  EvalConfig,
  EvalSetResultsManager,
  EvalSetsManager,
  getEvalMetricsFromConfig,
  getEvalRuntime,
  getEvaluationCriteriaOrDefault,
  InferenceConfig,
  InferenceRequest,
  InferenceResult,
  InMemoryEvalSetsManager,
  isApp,
  isBaseAgent,
  loadEvalSetFromFile,
  LocalEvalSetResultsManager,
  LocalEvalSetsManager,
  RunnableRoot,
} from '@google/adk';
import * as path from 'node:path';
import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {getAbsolutePath, isFileExists} from '../utils/file_utils.js';
import {
  printDetailedEvalResult,
  printEvalRunSummary,
} from './eval_result_printer.js';

/** The eval config file an eval set directory is expected to hold. */
const DEFAULT_EVAL_CONFIG_FILE = 'test_config.json';

/**
 * A path that starts with a Windows drive letter, whose colon is part of the
 * path rather than the start of an eval-case selector.
 */
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:[\\/]/;

/** Everything `adk eval` was asked to do. */
export interface EvalCliOptions {
  /** Path of the agent file to score. */
  agentPath: string;

  /** Each entry is `<file-or-id>` with an optional `:case1,case2` suffix. */
  evalSetFileOrIds: string[];

  /** Explicit eval config file, overriding the resolved one. */
  configFilePath?: string;

  /** Whether to print the per-case detail after the summary. */
  printDetailedResults: boolean;

  /** Where to read eval sets and write results. Only `gs://<bucket>`. */
  evalStorageUri?: string;

  agentFileLoadOptions?: AgentFileOptions;
}

/** Where an agent file puts its app name and its agents directory. */
export interface EvalAppLocation {
  appName: string;

  /** The directory the eval sets and the eval history live under. */
  agentsDir: string;
}

/**
 * Splits each `<file-or-id>[:case1,case2]` entry into the eval set it names
 * and the eval cases to run from it. An entry with no selector runs every
 * case, and repeating an eval set accumulates its cases.
 */
export function parseAndGetEvalsToRun(
  evalSetFileOrIds: readonly string[],
): Map<string, string[]> {
  const evalSetToEvals = new Map<string, string[]>();
  for (const entry of evalSetFileOrIds) {
    const searchFrom = WINDOWS_DRIVE_PREFIX.test(entry) ? 3 : 0;
    const separator = entry.indexOf(':', searchFrom);
    const evalSet = separator === -1 ? entry : entry.slice(0, separator);
    const evalCaseIds =
      separator === -1
        ? []
        : entry
            .slice(separator + 1)
            .split(':')[0]
            .split(',')
            .filter((evalCaseId) => evalCaseId.trim() !== '');

    const known = evalSetToEvals.get(evalSet);
    if (known) {
      known.push(...evalCaseIds);
    } else {
      evalSetToEvals.set(evalSet, evalCaseIds);
    }
  }
  return evalSetToEvals;
}

/**
 * Returns the eval config file to read.
 *
 * An explicit path wins. Otherwise a run over a single eval set *file* reads
 * the `test_config.json` next to it, and any other run uses the defaults.
 *
 * @param configFilePath The `--config_file_path` the user gave, if any.
 * @param soleEvalSetFile The one eval set file this run reads, when it reads
 *   exactly one; absent for a run over eval set ids or over several files.
 */
export function resolveEvalConfigFilePath(
  configFilePath: string | undefined,
  soleEvalSetFile: string | undefined,
): string | undefined {
  if (configFilePath) {
    return configFilePath;
  }
  return soleEvalSetFile === undefined
    ? undefined
    : path.join(path.dirname(soleEvalSetFile), DEFAULT_EVAL_CONFIG_FILE);
}

/**
 * Returns the app name and agents directory of an agent file.
 *
 * adk-js accepts both agent layouts: `<agentsDir>/<app>/agent.ts`, where the
 * app is the directory, and `<agentsDir>/<app>.ts`, where it is the file.
 */
export function resolveEvalAppLocation(agentPath: string): EvalAppLocation {
  const agentFile = getAbsolutePath(agentPath);
  const baseName = path.basename(agentFile, path.extname(agentFile));
  if (baseName === 'agent') {
    const appDir = path.dirname(agentFile);
    return {appName: path.basename(appDir), agentsDir: path.dirname(appDir)};
  }
  return {appName: baseName, agentsDir: path.dirname(agentFile)};
}

/** Returns how the agent is run, which the eval config decides. */
function toInferenceConfig(evalConfig: EvalConfig): InferenceConfig {
  const liveModelConfig = evalConfig.liveModelConfig;
  return liveModelConfig
    ? {useLive: true, liveTimeoutSeconds: liveModelConfig.timeoutSeconds}
    : {useLive: false};
}

/** The agent to score, and the app that wraps it when the module exposes one. */
function resolveRootAgent(
  loaded: RunnableRoot | App,
  agentPath: string,
): {rootAgent: BaseAgent; app?: App} {
  const app = isApp(loaded) ? loaded : undefined;
  const rootAgent: unknown = app ? app.rootAgent : loaded;
  if (!isBaseAgent(rootAgent)) {
    throw new Error(`\`${agentPath}\` does not export an agent to evaluate.`);
  }
  return {rootAgent, app};
}

/**
 * Builds the eval sets manager from the eval set *files* the run names, one
 * eval set per file, and returns it with the requests that read it.
 */
async function loadEvalSetsFromFiles(
  appName: string,
  evalSetFileToEvals: ReadonlyMap<string, string[]>,
  inferenceConfig: InferenceConfig,
): Promise<{
  evalSetsManager: EvalSetsManager;
  inferenceRequests: InferenceRequest[];
}> {
  const evalSetsManager = new InMemoryEvalSetsManager();
  const inferenceRequests: InferenceRequest[] = [];
  for (const [evalSetFilePath, evalCaseIds] of evalSetFileToEvals) {
    if (!(await isFileExists(evalSetFilePath))) {
      throw new Error(
        `\`${evalSetFilePath}\` should be a valid eval set file.`,
      );
    }
    const evalSet = await loadEvalSetFromFile(evalSetFilePath, evalSetFilePath);
    await evalSetsManager.createEvalSet(appName, evalSet.evalSetId);
    for (const evalCase of evalSet.evalCases) {
      await evalSetsManager.addEvalCase(appName, evalSet.evalSetId, evalCase);
    }
    inferenceRequests.push(
      toInferenceRequest(
        appName,
        evalSet.evalSetId,
        evalCaseIds,
        inferenceConfig,
      ),
    );
  }
  return {evalSetsManager, inferenceRequests};
}

/**
 * An empty selector means "every eval case", which the request spells as an
 * absent list rather than an empty one.
 */
function toInferenceRequest(
  appName: string,
  evalSetId: string,
  evalCaseIds: string[],
  inferenceConfig: InferenceConfig,
): InferenceRequest {
  return {
    appName,
    evalSetId,
    evalCaseIds: evalCaseIds.length > 0 ? evalCaseIds : undefined,
    inferenceConfig,
  };
}

/** Runs the eval sets an `adk eval` invocation named, and prints the result. */
export async function runEvalCli(options: EvalCliOptions): Promise<void> {
  // Resolved first: without a runtime there is nothing to run, and adk-python
  // likewise reports the missing dependency before it loads the agent.
  const evalRuntime = getEvalRuntime();
  const {appName, agentsDir} = resolveEvalAppLocation(options.agentPath);

  const evalSetFileOrIdToEvals = parseAndGetEvalsToRun(
    options.evalSetFileOrIds,
  );
  // The first entry decides how the rest are read, matching adk-python: a run
  // cannot mix eval set files with eval set ids.
  const [firstEvalSet] = evalSetFileOrIdToEvals.keys();
  const firstIsFile =
    firstEvalSet !== undefined && (await isFileExists(firstEvalSet));

  const evalConfig = await getEvaluationCriteriaOrDefault(
    resolveEvalConfigFilePath(
      options.configFilePath,
      firstIsFile && evalSetFileOrIdToEvals.size === 1
        ? firstEvalSet
        : undefined,
    ),
  );
  const inferenceConfig = toInferenceConfig(evalConfig);

  const gcsManagers = options.evalStorageUri
    ? createGcsEvalManagersFromUri(options.evalStorageUri)
    : undefined;
  const evalSetResultsManager: EvalSetResultsManager =
    gcsManagers?.evalSetResultsManager ??
    new LocalEvalSetResultsManager(agentsDir);

  const readsFiles = !gcsManagers && firstIsFile;

  let evalSetsManager: EvalSetsManager;
  let inferenceRequests: InferenceRequest[];
  if (readsFiles) {
    ({evalSetsManager, inferenceRequests} = await loadEvalSetsFromFiles(
      appName,
      evalSetFileOrIdToEvals,
      inferenceConfig,
    ));
  } else {
    evalSetsManager =
      gcsManagers?.evalSetsManager ?? new LocalEvalSetsManager(agentsDir);
    inferenceRequests = [...evalSetFileOrIdToEvals].map(
      ([evalSetId, evalCaseIds]) =>
        toInferenceRequest(appName, evalSetId, evalCaseIds, inferenceConfig),
    );
  }

  await using agentFile = new AgentFile(
    getAbsolutePath(options.agentPath),
    options.agentFileLoadOptions,
  );
  const {rootAgent, app} = resolveRootAgent(
    await agentFile.load(),
    options.agentPath,
  );

  const evalService = evalRuntime.createEvalService({
    rootAgent,
    app,
    evalSetsManager,
    evalConfig,
    evalSetResultsManager,
  });

  const inferenceResults: InferenceResult[] = [];
  for (const inferenceRequest of inferenceRequests) {
    for await (const inferenceResult of evalService.performInference(
      inferenceRequest,
    )) {
      inferenceResults.push(inferenceResult);
    }
  }

  const evalResults: EvalCaseResult[] = [];
  for await (const evalResult of evalService.evaluate({
    inferenceResults,
    evaluateConfig: {evalMetrics: getEvalMetricsFromConfig(evalConfig)},
  })) {
    evalResults.push(evalResult);
  }

  printEvalRunSummary(evalResults);
  if (options.printDetailedResults) {
    for (const evalResult of evalResults) {
      printDetailedEvalResult(evalResult);
    }
  }
}
