/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';
import type {ConversationScenario, Invocation} from './eval_case.js';
import type {EvalMetric} from './eval_metrics.js';
import {
  getConfigCustomFunctionPath,
  setConfigCustomFunctionPath,
} from './eval_metrics.js';
import type {EvaluationResult, Evaluator} from './evaluator.js';

/**
 * The call signature a caller-supplied scoring function must have.
 *
 * The function owns the whole verdict: {@link CustomMetricEvaluator} returns
 * what it produced without post-processing it.
 *
 * Each optional parameter is declared optional rather than as `X | undefined`,
 * so a function that reads only the invocations it cares about is assignable
 * without declaring parameters it ignores.
 */
export type CustomMetricFunction = (
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
) => EvaluationResult | Promise<EvaluationResult>;

function isCustomMetricFunction(value: unknown): value is CustomMetricFunction {
  return typeof value === 'function';
}

/**
 * Resolves the scoring function a custom metric names.
 *
 * The import runs the named module's top-level code, so a caller must trust
 * `customFunctionPath` as far as it trusts the eval config the path came from.
 * `resolveFullyQualifiedName` narrows that by refusing Node built-ins
 * and specifiers carrying a URL scheme. It is not a sandbox.
 *
 * @param customFunctionPath A `<module specifier>#<export>` name, or a bare
 *   specifier whose `default` export is the function.
 * @param baseFilePath Absolute path of the file the name came from. A relative
 *   specifier resolves against its directory and needs it.
 * @return The resolved function.
 * @throws {InputValidationError} When the module will not load, names no such
 *   export, or the export is not a function.
 */
export async function getMetricFunction(
  customFunctionPath: string,
  baseFilePath?: string,
): Promise<CustomMetricFunction> {
  let metricFunction: unknown;
  try {
    metricFunction = await resolveFullyQualifiedName(
      customFunctionPath,
      baseFilePath,
    );
  } catch (err: unknown) {
    throw new InputValidationError(
      `Could not import custom metric function from ${customFunctionPath}`,
      {cause: err},
    );
  }
  if (!isCustomMetricFunction(metricFunction)) {
    throw new InputValidationError(
      `Custom metric ${customFunctionPath} does not refer to a callable.`,
    );
  }
  return metricFunction;
}

/**
 * Returns the metric the scoring function is handed.
 *
 * The copy is deep, so a function that writes to the criterion cannot reach
 * the caller's metric. The metric-level `threshold` is cleared because it is
 * deprecated in favour of the criterion; `criterion.threshold` is left alone.
 * A `structuredClone` cannot carry the config-declared path, which is held
 * outside the object, so it is recorded on the copy explicitly.
 */
function copyMetricForFunction(evalMetric: EvalMetric): EvalMetric {
  const copy = structuredClone(evalMetric);
  delete copy.threshold;
  const configPath = getConfigCustomFunctionPath(evalMetric);
  if (configPath !== undefined) {
    setConfigCustomFunctionPath(copy, configPath);
  }
  return copy;
}

/** An {@link Evaluator} that scores with a caller-supplied function. */
export class CustomMetricEvaluator implements Evaluator {
  /**
   * The in-flight or settled resolution, kept so that the module is imported
   * once. The promise itself is memoized, so two concurrent first calls share
   * one import rather than starting two.
   */
  private metricFunction?: Promise<CustomMetricFunction>;

  /**
   * @param evalMetric The metric this evaluator scores. It is never mutated.
   * @param customFunctionPath The name of the scoring function, in the form
   *   {@link getMetricFunction} accepts.
   * @param baseFilePath Absolute path of the file `customFunctionPath` came
   *   from, needed when the specifier is relative.
   */
  constructor(
    private readonly evalMetric: EvalMetric,
    private readonly customFunctionPath: string,
    private readonly baseFilePath?: string,
  ) {}

  /**
   * Scores the invocations with the resolved function.
   *
   * The function is resolved on the first call rather than in the constructor,
   * because `import()` is asynchronous. A path that will not resolve is
   * therefore reported here.
   *
   * @throws {InputValidationError} When the scoring function cannot be
   *   resolved.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    this.metricFunction ??= getMetricFunction(
      this.customFunctionPath,
      this.baseFilePath,
    );
    const metricFunction = await this.metricFunction;
    return metricFunction(
      copyMetricForFunction(this.evalMetric),
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
