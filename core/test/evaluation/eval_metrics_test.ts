/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  getMetricThreshold,
  InputValidationError,
  normalizeToolTrajectoryMatchType,
  PrebuiltMetrics,
  resolveJudgeModelOptions,
  ToolTrajectoryMatchType,
  type EvalMetricResult,
  type HallucinationsCriterion,
  type LlmBackedUserSimulatorCriterion,
  type MetricInfoProvider,
  type RubricsBasedCriterion,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const METRIC_NAME = 'tool_trajectory_avg_score';

describe('getMetricThreshold', () => {
  it('prefers the criterion over the deprecated threshold field', () => {
    const threshold = getMetricThreshold({
      metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
      threshold: 0.2,
      criterion: {threshold: 0.9},
    });

    expect(threshold).toBe(0.9);
  });

  it('falls back to the threshold field', () => {
    const threshold = getMetricThreshold({
      metricName: PrebuiltMetrics.SAFETY_V1,
      threshold: 0.5,
    });

    expect(threshold).toBe(0.5);
  });

  it('rejects a metric that names no threshold', () => {
    expect(() => getMetricThreshold({metricName: 'my_metric'})).toThrowError(
      "Evaluation metric 'my_metric' requires a threshold.",
    );
  });

  it('prefers the criterion threshold over the metric threshold', () => {
    expect(
      getMetricThreshold({
        metricName: METRIC_NAME,
        threshold: 0.2,
        criterion: {threshold: 0.8},
      }),
    ).toBe(0.8);
  });

  it('falls back to the metric threshold when there is no criterion', () => {
    expect(getMetricThreshold({metricName: METRIC_NAME, threshold: 0.4})).toBe(
      0.4,
    );
  });

  it('honours a metric threshold of zero', () => {
    expect(getMetricThreshold({metricName: METRIC_NAME, threshold: 0})).toBe(0);
  });

  it('rejects a metric that carries no threshold at all', () => {
    expect(() => getMetricThreshold({metricName: METRIC_NAME})).toThrowError(
      new InputValidationError(
        `Evaluation metric '${METRIC_NAME}' requires a threshold.`,
      ),
    );
  });
});

describe('EvalStatus', () => {
  it('names the statuses the way the CSV output reports them', () => {
    expect(EvalStatus[EvalStatus.PASSED]).toBe('PASSED');
    expect(EvalStatus[EvalStatus.FAILED]).toBe('FAILED');
    expect(EvalStatus[EvalStatus.NOT_EVALUATED]).toBe('NOT_EVALUATED');
  });
});

describe('normalizeToolTrajectoryMatchType', () => {
  it('defaults to EXACT when no match type is given', () => {
    expect(normalizeToolTrajectoryMatchType(undefined)).toBe(
      ToolTrajectoryMatchType.EXACT,
    );
  });

  it.each([
    ['exact', ToolTrajectoryMatchType.EXACT],
    ['EXACT', ToolTrajectoryMatchType.EXACT],
    [' exact ', ToolTrajectoryMatchType.EXACT],
    ['in order', ToolTrajectoryMatchType.IN_ORDER],
    ['IN ORDER', ToolTrajectoryMatchType.IN_ORDER],
    ['In OrDeR', ToolTrajectoryMatchType.IN_ORDER],
    ['in-order', ToolTrajectoryMatchType.IN_ORDER],
    ['IN-ORDER', ToolTrajectoryMatchType.IN_ORDER],
    ['in_order', ToolTrajectoryMatchType.IN_ORDER],
    ['any order', ToolTrajectoryMatchType.ANY_ORDER],
    ['ANY ORDER', ToolTrajectoryMatchType.ANY_ORDER],
    ['any-order', ToolTrajectoryMatchType.ANY_ORDER],
    ['ANY-ORDER', ToolTrajectoryMatchType.ANY_ORDER],
    ['any_order', ToolTrajectoryMatchType.ANY_ORDER],
  ])('normalizes %s', (spelling, expected) => {
    expect(normalizeToolTrajectoryMatchType(spelling)).toBe(expected);
  });

  it('accepts an enum member', () => {
    expect(
      normalizeToolTrajectoryMatchType(ToolTrajectoryMatchType.ANY_ORDER),
    ).toBe(ToolTrajectoryMatchType.ANY_ORDER);
  });

  it.each([['random string'], [null], [7], [{}]])(
    'reads %s as no match type',
    (value: unknown) => {
      expect(normalizeToolTrajectoryMatchType(value)).toBeUndefined();
    },
  );
});

describe('resolveJudgeModelOptions', () => {
  it('applies every default when no options are given', () => {
    const resolved = resolveJudgeModelOptions();

    expect(resolved).toEqual({
      judgeModel: 'gemini-2.5-flash',
      judgeModelConfig: undefined,
      numSamples: 5,
      parallelismLimit: 1,
    });
  });

  it('applies every default when the options name no field', () => {
    expect(resolveJudgeModelOptions({})).toEqual({
      judgeModel: DEFAULT_JUDGE_MODEL,
      judgeModelConfig: undefined,
      numSamples: DEFAULT_JUDGE_NUM_SAMPLES,
      parallelismLimit: DEFAULT_JUDGE_PARALLELISM_LIMIT,
    });
  });

  it('passes explicit options through', () => {
    expect(
      resolveJudgeModelOptions({
        judgeModel: 'gemini-2.5-pro',
        numSamples: 3,
        parallelismLimit: 4,
      }),
    ).toEqual({
      judgeModel: 'gemini-2.5-pro',
      judgeModelConfig: undefined,
      numSamples: 3,
      parallelismLimit: 4,
    });
  });

  it('passes the judge model config through by reference', () => {
    const judgeModelConfig = {temperature: 0.1};

    expect(resolveJudgeModelOptions({judgeModelConfig}).judgeModelConfig).toBe(
      judgeModelConfig,
    );
  });

  it.each([[0], [-1]])(
    'rejects a parallelism limit of %s',
    (parallelismLimit: number) => {
      expect(() => resolveJudgeModelOptions({parallelismLimit})).toThrowError(
        new InputValidationError(
          `judgeModelOptions.parallelismLimit must be at least 1, but got ` +
            `${parallelismLimit}.`,
        ),
      );
    },
  );

  it('rejects a fractional parallelism limit', () => {
    expect(() =>
      resolveJudgeModelOptions({parallelismLimit: 1.5}),
    ).toThrowError(
      new InputValidationError(
        'judgeModelOptions.parallelismLimit must be an integer, but got 1.5.',
      ),
    );
  });

  it('rejects a fractional sample count', () => {
    expect(() => resolveJudgeModelOptions({numSamples: 2.5})).toThrowError(
      new InputValidationError(
        'judgeModelOptions.numSamples must be an integer, but got 2.5.',
      ),
    );
  });
});

describe('MetricInfoProvider', () => {
  it('describes the tool trajectory metric over the interval [0, 1]', () => {
    const provider: MetricInfoProvider = {
      getMetricInfo: () => ({
        metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
        description: 'Compares the actual tool calls with the expected ones.',
        metricValueInfo: {interval: {minValue: 0, maxValue: 1}},
      }),
    };

    expect(provider.getMetricInfo()).toEqual({
      metricName: 'tool_trajectory_avg_score',
      description: 'Compares the actual tool calls with the expected ones.',
      metricValueInfo: {interval: {minValue: 0, maxValue: 1}},
    });
  });

  it('describes the response evaluation score over the interval [1, 5]', () => {
    const provider: MetricInfoProvider = {
      getMetricInfo: () => ({
        metricName: PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
        metricValueInfo: {
          interval: {
            minValue: 1,
            openAtMin: false,
            maxValue: 5,
            openAtMax: false,
          },
        },
      }),
    };
    const info = provider.getMetricInfo();

    expect(info.metricName).toBe('response_evaluation_score');
    expect(info.description).toBeUndefined();
    expect(info.metricValueInfo.interval).toEqual({
      minValue: 1,
      openAtMin: false,
      maxValue: 5,
      openAtMax: false,
    });
  });
});

describe('criteria', () => {
  it('reads the threshold of a rubrics based criterion', () => {
    const criterion: RubricsBasedCriterion = {
      threshold: 0.8,
      includeIntermediateResponsesInFinal: true,
      judgeModelOptions: {judgeModel: 'gemini-2.5-pro', parallelismLimit: 4},
      rubrics: [
        {
          rubricId: 'r1',
          rubricContent: {textProperty: 'The answer cites a source.'},
        },
      ],
    };

    expect(
      getMetricThreshold({
        metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
        criterion,
      }),
    ).toBe(0.8);
  });

  it('reads the threshold of a hallucinations criterion', () => {
    const criterion: HallucinationsCriterion = {
      threshold: 0.6,
      evaluateIntermediateNlResponses: true,
    };

    expect(
      getMetricThreshold({
        metricName: PrebuiltMetrics.HALLUCINATIONS_V1,
        criterion,
      }),
    ).toBe(0.6);
  });

  it('reads the threshold of a user simulator criterion', () => {
    const criterion: LlmBackedUserSimulatorCriterion = {
      threshold: 0.7,
      stopSignal: DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
    };

    expect(
      getMetricThreshold({
        metricName: PrebuiltMetrics.PER_TURN_USER_SIMULATOR_QUALITY_V1,
        criterion,
      }),
    ).toBe(0.7);
  });

  it('keeps a tool trajectory criterion that ignores arguments', () => {
    expect(
      getMetricThreshold({
        metricName: METRIC_NAME,
        criterion: {
          threshold: 1,
          matchType: ToolTrajectoryMatchType.IN_ORDER,
          ignoreArgs: true,
        },
      }),
    ).toBe(1);
  });
});

describe('EvalMetricResult', () => {
  it('round-trips its rubric scores through JSON', () => {
    const result: EvalMetricResult = {
      metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      criterion: {threshold: 0.8},
      score: 0.9,
      evalStatus: EvalStatus.PASSED,
      details: {
        rubricScores: [{rubricId: 'r1', rationale: 'It cites one.', score: 1}],
      },
    };

    const parsed: EvalMetricResult = JSON.parse(JSON.stringify(result));

    expect(parsed).toEqual(result);
    expect(parsed.details?.rubricScores).toEqual([
      {rubricId: 'r1', rationale: 'It cites one.', score: 1},
    ]);
  });
});

describe('judge and simulator defaults', () => {
  it('matches the adk-python defaults', () => {
    expect(DEFAULT_JUDGE_MODEL).toBe('gemini-2.5-flash');
    expect(DEFAULT_JUDGE_NUM_SAMPLES).toBe(5);
    expect(DEFAULT_JUDGE_PARALLELISM_LIMIT).toBe(1);
    expect(DEFAULT_USER_SIMULATOR_STOP_SIGNAL).toBe('</finished>');
  });
});
