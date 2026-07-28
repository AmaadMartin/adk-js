/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';

/**
 * A user-supplied custom metric function.
 *
 * May be synchronous or asynchronous; the evaluator awaits the result either
 * way.
 */
export type CustomMetricFunction = (
  evalMetric: EvalMetric,
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
) => EvaluationResult | Promise<EvaluationResult>;

/**
 * Dynamically loads a custom metric function from a `<module>.<export>` path.
 *
 * The path is split on its final `.`: everything before is the module specifier
 * to import and the final segment is the exported function name.
 *
 * @param customFunctionPath A `<module>.<export>` path to the metric function.
 * @throws {Error} If the path is malformed, the module fails to import, or the
 *     named export is not a function.
 */
export async function getMetricFunction(
  customFunctionPath: string,
): Promise<CustomMetricFunction> {
  try {
    const separatorIndex = customFunctionPath.lastIndexOf('.');
    if (separatorIndex === -1) {
      throw new Error('Malformed custom function path.');
    }
    const moduleSpecifier = customFunctionPath.slice(0, separatorIndex);
    const functionName = customFunctionPath.slice(separatorIndex + 1);
    const module = (await import(moduleSpecifier)) as Record<string, unknown>;
    const metricFunction = module[functionName];
    if (typeof metricFunction !== 'function') {
      throw new Error(`No function named ${functionName} in module.`);
    }
    return metricFunction as CustomMetricFunction;
  } catch (error) {
    throw new Error(
      `Could not import custom metric function from ${customFunctionPath}`,
      {cause: error},
    );
  }
}

/**
 * Options for constructing a {@link CustomMetricEvaluator}.
 */
export interface CustomMetricEvaluatorOptions {
  /** The metric being evaluated. */
  evalMetric: EvalMetric;
  /** The `<module>.<export>` path to the custom metric function. */
  customFunctionPath: string;
}

/**
 * Evaluator that dispatches to a user-supplied custom metric function loaded
 * dynamically by path.
 *
 * The function is resolved lazily inside {@link evaluateInvocations} (dynamic
 * `import()` is asynchronous), so the constructor stores only the path.
 */
export class CustomMetricEvaluator extends Evaluator {
  private readonly evalMetric: EvalMetric;
  private readonly customFunctionPath: string;

  constructor({evalMetric, customFunctionPath}: CustomMetricEvaluatorOptions) {
    super();
    this.evalMetric = evalMetric;
    this.customFunctionPath = customFunctionPath;
  }

  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    const metricFunction = await getMetricFunction(this.customFunctionPath);
    const evalMetric: EvalMetric = {
      ...structuredClone(this.evalMetric),
      threshold: undefined,
    };
    return metricFunction(
      evalMetric,
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
