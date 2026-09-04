/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {
  PrebuiltMetrics,
  type MetricInfo,
  type MetricInfoProvider,
} from './eval_metrics.js';

/**
 * Builds a {@link MetricInfo} whose values are drawn from a closed interval.
 *
 * `openAtMin` and `openAtMax` are written explicitly so a serialized adk-js
 * `MetricInfo` carries the same fields as a serialized adk-python one, where
 * they are pydantic defaults rather than omitted keys.
 */
function closedIntervalMetricInfo(
  metricName: PrebuiltMetrics,
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

/** Describes the `tool_trajectory_avg_score` metric. */
export class TrajectoryEvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      'This metric compares two tool call trajectories (expected vs.' +
        ' actual) for the same user interaction. It performs an exact match' +
        ' on the tool name and arguments for each step in the trajectory.' +
        ' A score of 1.0 indicates a perfect match, while 0.0 indicates a' +
        ' mismatch. Higher values are better.',
      0.0,
      1.0,
    );
  }
}

/**
 * Describes either the `response_evaluation_score` or the
 * `response_match_score` metric, whichever the constructor names.
 */
export class ResponseEvaluatorMetricInfoProvider implements MetricInfoProvider {
  constructor(private readonly metricName: string) {}

  /**
   * @throws {InputValidationError} When the stored name is neither
   *   `response_evaluation_score` nor `response_match_score`.
   */
  getMetricInfo(): MetricInfo {
    if (this.metricName === PrebuiltMetrics.RESPONSE_EVALUATION_SCORE) {
      return closedIntervalMetricInfo(
        PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
        "This metric evaluates how coherent agent's response was. Value" +
          ' range of this metric is [1,5], with values closer to 5 more' +
          ' desirable.',
        1.0,
        5.0,
      );
    }
    if (this.metricName === PrebuiltMetrics.RESPONSE_MATCH_SCORE) {
      return closedIntervalMetricInfo(
        PrebuiltMetrics.RESPONSE_MATCH_SCORE,
        "This metric evaluates if the agent's final response matches a" +
          ' golden/expected final response using Rouge_1 metric. Value' +
          ' range for this metric is [0,1], with values closer to 1 more' +
          ' desirable.',
        0.0,
        1.0,
      );
    }
    throw new InputValidationError(`\`${this.metricName}\` is not supported.`);
  }
}

/** Describes the `safety_v1` metric. */
export class SafetyEvaluatorV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.SAFETY_V1,
      "This metric evaluates the safety (harmlessness) of an Agent's" +
        ' Response. Value range of the metric is [0, 1], with values closer' +
        ' to 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/** Describes the `multi_turn_task_success_v1` metric. */
export class MultiTurnTaskSuccessV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      'Evaluates if the agent was able to achieve the goal or goals of' +
        ' the conversation.' +
        ' Value range of the metric is [0, 1], with values closer' +
        ' to 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/** Describes the `multi_turn_trajectory_quality_v1` metric. */
export class MultiTurnTrajectoryQualityV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
      'Evaluates the overall trajectory of the conversation. Note that' +
        ' this metric is different from `Multi-Turn Overall Task Success`,' +
        ' in the sense that task success only concerns itself with the' +
        ' goal of whether the success was achieved or not. How that was' +
        ' achieved is not its concern. This metric on the other hand does' +
        ' care about the path that agent took to achieve the goal. This is' +
        ' a reference free metric.' +
        ' Value range of the metric is [0, 1], with values closer' +
        ' to 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/** Describes the `multi_turn_tool_use_quality_v1` metric. */
export class MultiTurnToolUseQualityV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
      'Evaluates the function calls made during a multi-turn' +
        ' conversation. This is a reference free metric.' +
        ' Value range of the metric is [0, 1], with values closer' +
        ' to 1 to be more desirable (safe).',
      0.0,
      1.0,
    );
  }
}

/** Describes the `final_response_match_v2` metric. */
export class FinalResponseMatchV2EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
      "This metric evaluates if the agent's final response matches a" +
        ' golden/expected final response using LLM as a judge. Value range' +
        ' for this metric is [0,1], with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}

/** Describes the `rubric_based_final_response_quality_v1` metric. */
export class RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      "This metric assess if the agent's final response against a set of" +
        ' rubrics using LLM as a judge. Value range for this metric is' +
        ' [0,1], with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}

/** Describes the `hallucinations_v1` metric. */
export class HallucinationsV1EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
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

/** Describes the `rubric_based_tool_use_quality_v1` metric. */
export class RubricBasedToolUseV1EvaluatorMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
      "This metric assess if the agent's usage of tools against a set of" +
        ' rubrics using LLM as a judge. Value range for this metric is' +
        ' [0,1], with values closer to 1 more desirable.',
      0.0,
      1.0,
    );
  }
}

/** Describes the `per_turn_user_simulator_quality_v1` metric. */
export class PerTurnUserSimulatorQualityV1MetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.PER_TURN_USER_SIMULATOR_QUALITY_V1,
      'This metric evaluates if the user messages generated by a ' +
        'user simulator follow the given conversation scenario. It ' +
        'validates each message separately. The resulting metric ' +
        'computes the percentage of user messages that we mark as ' +
        'valid. The value range for this metric is [0,1], with values ' +
        'closer to 1 more desirable. ',
      0.0,
      1.0,
    );
  }
}

/** Describes the `rubric_based_multi_turn_trajectory_quality_v1` metric. */
export class RubricBasedMultiTurnTrajectoryMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return closedIntervalMetricInfo(
      PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
      "This metric evaluates the agent's multi-turn trajectory against" +
        ' a set of user-provided rubrics using an LLM as a judge. Value' +
        ' range for this metric is [0,1], with values closer to 1 more' +
        ' desirable.',
      0.0,
      1.0,
    );
  }
}
