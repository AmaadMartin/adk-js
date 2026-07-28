/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MetricInfo,
  MetricInfoProvider,
  PrebuiltMetrics,
} from './eval_metrics.js';

/**
 * Builds a {@link MetricInfo} whose value type is a closed numeric interval.
 */
function intervalMetricInfo(
  metricName: string,
  description: string,
  minValue: number,
  maxValue: number,
): MetricInfo {
  return {
    metricName,
    description,
    metricValueInfo: {
      interval: {minValue, openAtMin: false, maxValue, openAtMax: false},
    },
  };
}

/**
 * Metric info provider for the TrajectoryEvaluator.
 */
export class TrajectoryEvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      'This metric compares two tool call trajectories (expected vs. actual)' +
        ' for the same user interaction. It performs an exact match on the' +
        ' tool name and arguments for each step in the trajectory. A score of' +
        ' 1.0 indicates a perfect match, while 0.0 indicates a mismatch.' +
        ' Higher values are better.',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for the ResponseEvaluator.
 */
export class ResponseEvaluatorMetricInfoProvider implements MetricInfoProvider {
  constructor(private readonly metricName: string) {}

  getMetricInfo(): MetricInfo {
    if (this.metricName === PrebuiltMetrics.RESPONSE_EVALUATION_SCORE) {
      return intervalMetricInfo(
        PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
        "This metric evaluates how coherent agent's response was. Value range" +
          ' of this metric is [1,5], with values closer to 5 more desirable.',
        1.0,
        5.0,
      );
    } else if (this.metricName === PrebuiltMetrics.RESPONSE_MATCH_SCORE) {
      return intervalMetricInfo(
        PrebuiltMetrics.RESPONSE_MATCH_SCORE,
        "This metric evaluates if the agent's final response matches a" +
          ' golden/expected final response using Rouge_1 metric. Value range' +
          ' for this metric is [0,1], with values closer to 1 more desirable.',
        0.0,
        1.0,
      );
    }
    throw new Error(`\`${this.metricName}\` is not supported.`);
  }
}

/**
 * Metric info provider for the SafetyEvaluatorV1.
 */
export class SafetyEvaluatorV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.SAFETY_V1,
      "This metric evaluates the safety (harmlessness) of an Agent's Response." +
        ' Value range of the metric is [0, 1], with values closer to 1 to be' +
        ' more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for MultiTurnTaskSuccessV1.
 */
export class MultiTurnTaskSuccessV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      'Evaluates if the agent was able to achieve the goal or goals of the' +
        ' conversation. Value range of the metric is [0, 1], with values' +
        ' closer to 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for MultiTurnTrajectoryQualityV1.
 */
export class MultiTurnTrajectoryQualityV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
      'Evaluates the overall trajectory of the conversation. Note that this' +
        ' metric is different from `Multi-Turn Overall Task Success`, in the' +
        ' sense that task success only concerns itself with the goal of' +
        ' whether the success was achieved or not. How that was achieved is' +
        ' not its concern. This metric on the other hand does care about the' +
        ' path that agent took to achieve the goal. This is a reference free' +
        ' metric. Value range of the metric is [0, 1], with values closer to' +
        ' 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for MultiTurnToolUseQualityV1.
 */
export class MultiTurnToolUseQualityV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
      'Evaluates the function calls made during a multi-turn conversation.' +
        ' This is a reference free metric. Value range of the metric is' +
        ' [0, 1], with values closer to 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for the FinalResponseMatchV2Evaluator.
 */
export class FinalResponseMatchV2EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
      "This metric evaluates if the agent's final response matches a" +
        ' golden/expected final response using LLM as a judge. Value range' +
        ' for this metric is [0,1], with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for the RubricBasedFinalResponseQualityV1Evaluator.
 */
export class RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      "This metric assess if the agent's final response against a set of" +
        ' rubrics using LLM as a judge. Value range for this metric is [0,1],' +
        ' with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for the HallucinationsV1Evaluator.
 */
export class HallucinationsV1EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.HALLUCINATIONS_V1,
      'This metric assesses whether a model response contains any false,' +
        ' contradictory, or unsupported claims using a LLM as judge. Value' +
        ' range for this metric is [0,1], with values closer to 1 more' +
        ' desirable.',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for the RubricBasedToolUseV1Evaluator.
 */
export class RubricBasedToolUseV1EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
      "This metric assess if the agent's usage of tools against a set of" +
        ' rubrics using LLM as a judge. Value range for this metric is [0,1],' +
        ' with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for PerTurnUserSimulatorQualityV1.
 */
export class PerTurnUserSimulatorQualityV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.PER_TURN_USER_SIMULATOR_QUALITY_V1,
      'This metric evaluates if the user messages generated by a user' +
        ' simulator follow the given conversation scenario. It validates each' +
        ' message separately. The resulting metric computes the percentage of' +
        ' user messages that we mark as valid. The value range for this' +
        ' metric is [0,1], with values closer to 1 more desirable. ',
      0.0,
      1.0,
    );
  }
}

/**
 * Metric info provider for RubricBasedMultiTurnTrajectory.
 */
export class RubricBasedMultiTurnTrajectoryMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return intervalMetricInfo(
      PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
      "This metric evaluates the agent's multi-turn trajectory against a set" +
        ' of user-provided rubrics using an LLM as a judge. Value range for' +
        ' this metric is [0,1], with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}
