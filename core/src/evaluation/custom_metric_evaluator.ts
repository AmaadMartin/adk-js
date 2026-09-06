/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scores a metric with a function the caller wrote.
 *
 * This is a port of adk-python's
 * `src/google/adk/evaluation/custom_metric_evaluator.py`.
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {ConversationScenario, Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';

/** The shape a custom scoring function must have. */
export type CustomMetricFunction = (
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
) => EvaluationResult | Promise<EvaluationResult>;

/** Separates a module specifier from the export name inside it. */
const EXPORT_SEPARATOR = '#';

/**
 * Loads the scoring function a path names.
 *
 * The path is `<specifier>#<exportName>`, or a bare specifier whose default
 * export is the function. adk-python splits a dotted Python path on its last
 * `.`; a JavaScript module specifier contains dots, so this SDK marks the
 * export explicitly instead.
 *
 * Importing the specifier executes the module. It comes from the developer's
 * own eval config, at the same trust level as the agent module the eval run
 * already imports.
 *
 * @throws {InputValidationError} When the specifier will not import, or the
 *   named export is not a function.
 */
async function getMetricFunction(
  customFunctionPath: string,
): Promise<CustomMetricFunction> {
  const separatorIndex = customFunctionPath.lastIndexOf(EXPORT_SEPARATOR);
  const specifier =
    separatorIndex === -1
      ? customFunctionPath
      : customFunctionPath.slice(0, separatorIndex);
  const exportName =
    separatorIndex === -1
      ? 'default'
      : customFunctionPath.slice(separatorIndex + 1);

  let module: Record<string, unknown>;
  try {
    module = (await import(specifier)) as Record<string, unknown>;
  } catch (err: unknown) {
    throw new InputValidationError(
      `Could not import custom metric function from ${customFunctionPath}`,
      {cause: err},
    );
  }

  const metricFunction = module[exportName];
  if (typeof metricFunction !== 'function') {
    throw new InputValidationError(
      `Custom metric ${customFunctionPath} does not refer to a callable.`,
    );
  }
  return metricFunction as CustomMetricFunction;
}

/** Scores a metric declared in an eval config's `customMetrics`. */
export class CustomMetricEvaluator implements Evaluator {
  constructor(
    private readonly evalMetric: EvalMetric,
    private readonly customFunctionPath: string,
  ) {}

  /**
   * Scores the invocations with the configured function.
   *
   * The metric handed to the function carries no threshold: the function
   * decides the score, and the caller decides whether that score passes.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    const metricFunction = await getMetricFunction(this.customFunctionPath);
    const {threshold: _unusedThreshold, ...evalMetric} = this.evalMetric;
    return metricFunction(
      evalMetric,
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
