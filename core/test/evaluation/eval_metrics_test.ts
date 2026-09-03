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
  getConfigCustomFunctionPath,
  getMetricThreshold,
  InputValidationError,
  normalizeToolTrajectoryMatchType,
  parseBaseCriterion,
  parseEvalMetric,
  parseEvalMetricResult,
  parseHallucinationsCriterion,
  parseInterval,
  parseJudgeModelOptions,
  parseLlmAsAJudgeCriterion,
  parseLlmBackedUserSimulatorCriterion,
  parseMetricInfo,
  parseMetricValueInfo,
  parseRubricsBasedCriterion,
  parseToolTrajectoryCriterion,
  PrebuiltMetrics,
  resolveJudgeModelOptions,
  setConfigCustomFunctionPath,
  ToolTrajectoryMatchType,
  type EvalMetricResult,
  type HallucinationsCriterion,
  type JudgeModelOptions,
  type LlmBackedUserSimulatorCriterion,
  type MetricInfo,
  type MetricInfoProvider,
  type Rubric,
  type RubricsBasedCriterion,
} from '@google/adk';
import type {GenerateContentConfig} from '@google/genai';
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

const JUDGE_MODEL_DEFAULTS: JudgeModelOptions = {
  judgeModel: 'gemini-2.5-flash',
  judgeModelConfig: undefined,
  numSamples: 5,
  parallelismLimit: 1,
};

describe('PrebuiltMetrics', () => {
  it('carries the metric names adk-python writes to disk', () => {
    expect({...PrebuiltMetrics}).toEqual({
      TOOL_TRAJECTORY_AVG_SCORE: 'tool_trajectory_avg_score',
      RESPONSE_EVALUATION_SCORE: 'response_evaluation_score',
      RESPONSE_MATCH_SCORE: 'response_match_score',
      SAFETY_V1: 'safety_v1',
      FINAL_RESPONSE_MATCH_V2: 'final_response_match_v2',
      RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1:
        'rubric_based_final_response_quality_v1',
      HALLUCINATIONS_V1: 'hallucinations_v1',
      RUBRIC_BASED_TOOL_USE_QUALITY_V1: 'rubric_based_tool_use_quality_v1',
      PER_TURN_USER_SIMULATOR_QUALITY_V1: 'per_turn_user_simulator_quality_v1',
      MULTI_TURN_TASK_SUCCESS_V1: 'multi_turn_task_success_v1',
      MULTI_TURN_TRAJECTORY_QUALITY_V1: 'multi_turn_trajectory_quality_v1',
      MULTI_TURN_TOOL_USE_QUALITY_V1: 'multi_turn_tool_use_quality_v1',
      RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1:
        'rubric_based_multi_turn_trajectory_quality_v1',
    });
  });
});

describe('EvalStatus', () => {
  it('keeps the numeric values adk-python assigns', () => {
    expect(EvalStatus.PASSED).toBe(1);
    expect(EvalStatus.FAILED).toBe(2);
    expect(EvalStatus.NOT_EVALUATED).toBe(3);
  });

  it('reverse maps each value to its name', () => {
    expect(EvalStatus[1]).toBe('PASSED');
    expect(EvalStatus[2]).toBe('FAILED');
    expect(EvalStatus[3]).toBe('NOT_EVALUATED');
  });
});

describe('parseJudgeModelOptions', () => {
  it('applies every default to an empty payload', () => {
    expect(parseJudgeModelOptions({})).toEqual(JUDGE_MODEL_DEFAULTS);
  });

  it('reads the adk-python spelling of every field', () => {
    const fromSnakeCase = parseJudgeModelOptions({
      judge_model: 'gemini-2.5-pro',
      num_samples: 3,
      parallelism_limit: 4,
    });

    expect(fromSnakeCase).toEqual(
      parseJudgeModelOptions({
        judgeModel: 'gemini-2.5-pro',
        numSamples: 3,
        parallelismLimit: 4,
      }),
    );
    expect(fromSnakeCase.judgeModel).toBe('gemini-2.5-pro');
  });

  it('accepts a parallelism limit of 1', () => {
    expect(parseJudgeModelOptions({parallelismLimit: 1}).parallelismLimit).toBe(
      1,
    );
  });

  it('rejects a parallelism limit of 0', () => {
    expect(() => parseJudgeModelOptions({parallelismLimit: 0})).toThrow(
      /Invalid JudgeModelOptions: parallelismLimit: /,
    );
    expect(() => parseJudgeModelOptions({parallelismLimit: 0})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a negative parallelism limit', () => {
    expect(() => parseJudgeModelOptions({parallelism_limit: -3})).toThrow(
      /Invalid JudgeModelOptions: parallelismLimit: /,
    );
  });

  it('rejects a fractional parallelism limit', () => {
    expect(() => parseJudgeModelOptions({parallelismLimit: 2.5})).toThrow(
      /Invalid JudgeModelOptions: parallelismLimit: /,
    );
  });

  it('rejects a fractional sample count', () => {
    expect(() => parseJudgeModelOptions({numSamples: 1.5})).toThrow(
      /Invalid JudgeModelOptions: numSamples: /,
    );
  });

  it('passes the judge model config through by reference', () => {
    const judgeModelConfig: GenerateContentConfig = {temperature: 0.2};

    expect(parseJudgeModelOptions({judgeModelConfig}).judgeModelConfig).toBe(
      judgeModelConfig,
    );
  });

  it('rejects an unrecognized key', () => {
    expect(() => parseJudgeModelOptions({judge_mdel: 'typo'})).toThrow(
      'Invalid JudgeModelOptions: Unrecognized key: "judge_mdel"',
    );
  });
});

describe('parseBaseCriterion', () => {
  it('defaults includeIntermediateResponsesInFinal to false', () => {
    expect(parseBaseCriterion({threshold: 0.5})).toEqual({
      threshold: 0.5,
      includeIntermediateResponsesInFinal: false,
    });
  });

  it('keeps the metric specific keys a config carries', () => {
    expect(
      parseBaseCriterion({threshold: 0.5, rubrics: [{rubric_id: 'g'}]}),
    ).toEqual({
      threshold: 0.5,
      includeIntermediateResponsesInFinal: false,
      rubrics: [{rubric_id: 'g'}],
    });
  });

  it('reads the adk-python spelling of includeIntermediateResponsesInFinal', () => {
    expect(
      parseBaseCriterion({
        threshold: 0.5,
        include_intermediate_responses_in_final: true,
      }).includeIntermediateResponsesInFinal,
    ).toBe(true);
  });

  it('rejects a criterion that names no threshold', () => {
    expect(() => parseBaseCriterion({})).toThrow(
      /Invalid BaseCriterion: threshold: /,
    );
  });
});

describe('parseLlmAsAJudgeCriterion', () => {
  it('fills the judge model options with every default', () => {
    expect(parseLlmAsAJudgeCriterion({threshold: 0.5})).toEqual({
      threshold: 0.5,
      includeIntermediateResponsesInFinal: false,
      judgeModelOptions: JUDGE_MODEL_DEFAULTS,
    });
  });

  it('reads a partial judge model options payload', () => {
    expect(
      parseLlmAsAJudgeCriterion({
        threshold: 0.5,
        judge_model_options: {judge_model: 'gemini-2.5-pro'},
      }).judgeModelOptions,
    ).toEqual({...JUDGE_MODEL_DEFAULTS, judgeModel: 'gemini-2.5-pro'});
  });

  it('rejects an invalid judge model options payload', () => {
    expect(() =>
      parseLlmAsAJudgeCriterion({
        threshold: 0.5,
        judge_model_options: {parallelism_limit: 0},
      }),
    ).toThrow(/judgeModelOptions.parallelismLimit: /);
  });

  it('rejects a value that is not an object', () => {
    expect(() => parseLlmAsAJudgeCriterion('0.5')).toThrow(
      InputValidationError,
    );
  });

  it('names the criterion type it parses', () => {
    expect(parseLlmAsAJudgeCriterion.criterionName).toBe(
      'LlmAsAJudgeCriterion',
    );
  });
});

describe('parseRubricsBasedCriterion', () => {
  it('defaults the rubrics to an empty list', () => {
    expect(parseRubricsBasedCriterion({threshold: 0.5}).rubrics).toEqual([]);
  });

  it('names the criterion type it parses', () => {
    expect(parseRubricsBasedCriterion.criterionName).toBe(
      'RubricsBasedCriterion',
    );
  });

  it('gives each parsed criterion its own rubrics array', () => {
    const first = parseRubricsBasedCriterion({threshold: 0.5});
    const second = parseRubricsBasedCriterion({threshold: 0.5});

    expect(first.rubrics).not.toBe(second.rubrics);
  });

  it('validates each supplied rubric', () => {
    const criterion = parseRubricsBasedCriterion({
      threshold: 0.7,
      judge_model_options: {parallelism_limit: 4},
      rubrics: [
        {
          rubric_id: 'grammar',
          rubric_content: {text_property: 'The response is grammatical.'},
          type: 'FINAL_RESPONSE_QUALITY',
        },
      ],
    });

    expect(criterion.rubrics).toEqual([
      {
        rubricId: 'grammar',
        rubricContent: {textProperty: 'The response is grammatical.'},
        type: 'FINAL_RESPONSE_QUALITY',
      },
    ]);
    expect(criterion.judgeModelOptions?.parallelismLimit).toBe(4);
    expect(criterion.judgeModelOptions?.numSamples).toBe(5);
  });

  it('names the offending rubric when one is invalid', () => {
    expect(() =>
      parseRubricsBasedCriterion({
        threshold: 0.5,
        rubrics: [{rubric_content: {}}],
      }),
    ).toThrow(/rubrics.0.rubricId: /);
  });
});

describe('parseHallucinationsCriterion', () => {
  it('defaults evaluateIntermediateNlResponses to false', () => {
    expect(parseHallucinationsCriterion({threshold: 0.5})).toEqual({
      threshold: 0.5,
      includeIntermediateResponsesInFinal: false,
      judgeModelOptions: JUDGE_MODEL_DEFAULTS,
      evaluateIntermediateNlResponses: false,
    });
  });

  it('reads the adk-python spelling of evaluateIntermediateNlResponses', () => {
    expect(
      parseHallucinationsCriterion({
        threshold: 0.5,
        evaluate_intermediate_nl_responses: true,
      }).evaluateIntermediateNlResponses,
    ).toBe(true);
  });
});

describe('parseLlmBackedUserSimulatorCriterion', () => {
  it('defaults the stop signal and the judge model options', () => {
    expect(parseLlmBackedUserSimulatorCriterion({threshold: 0.5})).toEqual({
      threshold: 0.5,
      includeIntermediateResponsesInFinal: false,
      judgeModelOptions: JUDGE_MODEL_DEFAULTS,
      stopSignal: '</finished>',
    });
  });

  it('keeps a supplied stop signal', () => {
    expect(
      parseLlmBackedUserSimulatorCriterion({
        threshold: 0.5,
        stop_signal: '<<done>>',
      }).stopSignal,
    ).toBe('<<done>>');
  });
});

describe('parseToolTrajectoryCriterion', () => {
  it('defaults the match type to EXACT and ignoreArgs to false', () => {
    expect(parseToolTrajectoryCriterion({threshold: 1})).toEqual({
      threshold: 1,
      includeIntermediateResponsesInFinal: false,
      matchType: ToolTrajectoryMatchType.EXACT,
      ignoreArgs: false,
    });
  });

  it.each([
    ['in order', ToolTrajectoryMatchType.IN_ORDER],
    ['IN-ORDER', ToolTrajectoryMatchType.IN_ORDER],
    ['in_order', ToolTrajectoryMatchType.IN_ORDER],
    ['any order', ToolTrajectoryMatchType.ANY_ORDER],
    [ToolTrajectoryMatchType.ANY_ORDER, ToolTrajectoryMatchType.ANY_ORDER],
  ])('reads %s as the match type %s', (written, expected) => {
    expect(
      parseToolTrajectoryCriterion({threshold: 1, match_type: written})
        .matchType,
    ).toBe(expected);
  });

  it('reads the adk-python spelling of ignoreArgs', () => {
    expect(
      parseToolTrajectoryCriterion({threshold: 1, ignore_args: true})
        .ignoreArgs,
    ).toBe(true);
  });

  it('rejects a match type it cannot resolve', () => {
    expect(() =>
      parseToolTrajectoryCriterion({threshold: 1, match_type: 'sideways'}),
    ).toThrow(
      'Invalid ToolTrajectoryCriterion: matchType: Invalid tool trajectory match type: "sideways"',
    );
  });
});

describe('normalizeToolTrajectoryMatchType', () => {
  it('reads an absent value as the field default', () => {
    expect(normalizeToolTrajectoryMatchType(undefined)).toBe(
      ToolTrajectoryMatchType.EXACT,
    );
  });

  it('returns undefined for a value that is not a string', () => {
    expect(normalizeToolTrajectoryMatchType(7)).toBeUndefined();
  });

  it('returns undefined for a string it does not know', () => {
    expect(normalizeToolTrajectoryMatchType('sideways')).toBeUndefined();
  });
});

describe('getMetricThreshold', () => {
  it('prefers the criterion threshold over the metric one', () => {
    expect(
      getMetricThreshold({
        metricName: 'm',
        threshold: 0.2,
        criterion: {threshold: 0.9, includeIntermediateResponsesInFinal: false},
      }),
    ).toBe(0.9);
  });

  it('falls back to the metric threshold', () => {
    expect(getMetricThreshold({metricName: 'm', threshold: 0.2})).toBe(0.2);
  });

  it('honours a metric threshold of zero', () => {
    expect(getMetricThreshold({metricName: 'm', threshold: 0})).toBe(0);
  });

  it('rejects a metric that names neither', () => {
    expect(() => getMetricThreshold({metricName: 'm'})).toThrow(
      "Evaluation metric 'm' requires a threshold.",
    );
    expect(() => getMetricThreshold({metricName: 'm'})).toThrow(
      InputValidationError,
    );
  });
});

describe('parseEvalMetric', () => {
  it('reads the adk-python spelling of every field', () => {
    expect(
      parseEvalMetric({
        metric_name: 'x',
        threshold: 0.5,
        custom_function_path: 'math.floor',
      }),
    ).toEqual({
      metricName: 'x',
      threshold: 0.5,
      customFunctionPath: 'math.floor',
    });
  });

  it('keeps the subclass fields of a criterion', () => {
    const metric = parseEvalMetric({
      metric_name: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      criterion: {threshold: 0.7, rubrics: [{rubric_id: 'g'}]},
    });

    expect(metric.criterion).toEqual({
      threshold: 0.7,
      includeIntermediateResponsesInFinal: false,
      rubrics: [{rubric_id: 'g'}],
    });
  });

  it('rejects a metric that names no name', () => {
    expect(() => parseEvalMetric({threshold: 0.5})).toThrow(
      /Invalid EvalMetric: metricName: /,
    );
  });

  it('rejects a payload naming the private adk-python config path', () => {
    expect(() =>
      parseEvalMetric({
        metric_name: 'x',
        threshold: 0.5,
        _config_custom_function_path: 'math.floor',
      }),
    ).toThrow(
      'Invalid EvalMetric: Unrecognized key: "_config_custom_function_path"',
    );
  });

  it('rejects a payload naming the config path in camelCase', () => {
    expect(() =>
      parseEvalMetric({
        metric_name: 'x',
        threshold: 0.5,
        configCustomFunctionPath: 'math.floor',
      }),
    ).toThrow(
      'Invalid EvalMetric: Unrecognized key: "configCustomFunctionPath"',
    );
  });
});

describe('the config declared custom function path', () => {
  it('is absent on a metric built from a payload', () => {
    const metric = parseEvalMetric({
      metric_name: 'x',
      threshold: 0.5,
      custom_function_path: 'math.floor',
    });

    expect(getConfigCustomFunctionPath(metric)).toBeUndefined();
  });

  it('is readable once an eval config declares it', () => {
    const metric = parseEvalMetric({metric_name: 'x', threshold: 0.5});

    setConfigCustomFunctionPath(metric, 'math.sqrt');

    expect(getConfigCustomFunctionPath(metric)).toBe('math.sqrt');
  });

  it('does not carry to another config metric of the same name', () => {
    const mine = parseEvalMetric({metric_name: 'x', threshold: 0.5});
    const theirs = parseEvalMetric({metric_name: 'x', threshold: 0.5});

    setConfigCustomFunctionPath(mine, 'math.sqrt');

    expect(getConfigCustomFunctionPath(theirs)).toBeUndefined();
  });
});

describe('parseEvalMetricResult', () => {
  it('defaults the details to an empty object', () => {
    expect(
      parseEvalMetricResult({
        metric_name: 'x',
        threshold: 0.5,
        eval_status: EvalStatus.PASSED,
      }),
    ).toEqual({
      metricName: 'x',
      threshold: 0.5,
      evalStatus: EvalStatus.PASSED,
      details: {},
    });
  });

  it('validates each rubric score in the details', () => {
    expect(
      parseEvalMetricResult({
        metric_name: 'x',
        threshold: 0.5,
        eval_status: EvalStatus.FAILED,
        score: 0,
        details: {
          rubric_scores: [
            {rubric_id: 'g', rationale: 'It reads badly.', score: 0},
          ],
        },
      }),
    ).toEqual({
      metricName: 'x',
      threshold: 0.5,
      evalStatus: EvalStatus.FAILED,
      score: 0,
      details: {
        rubricScores: [{rubricId: 'g', rationale: 'It reads badly.', score: 0}],
      },
    });
  });

  it('names the offending rubric score when one is invalid', () => {
    expect(() =>
      parseEvalMetricResult({
        metric_name: 'x',
        eval_status: EvalStatus.PASSED,
        details: {rubric_scores: [{score: 1}]},
      }),
    ).toThrow(/details.rubricScores.0.rubricId: /);
  });

  it('rejects a result that names no status', () => {
    expect(() => parseEvalMetricResult({metric_name: 'x'})).toThrow(
      /Invalid EvalMetricResult: evalStatus: /,
    );
  });

  it('rejects a status outside the enum', () => {
    expect(() =>
      parseEvalMetricResult({metric_name: 'x', eval_status: 9}),
    ).toThrow(/Invalid EvalMetricResult: evalStatus: /);
  });
});

describe('parseInterval', () => {
  it('defaults both ends to closed', () => {
    expect(parseInterval({minValue: 0, maxValue: 1})).toEqual({
      minValue: 0,
      openAtMin: false,
      maxValue: 1,
      openAtMax: false,
    });
  });

  it('reads the adk-python spelling of the open flags', () => {
    expect(
      parseInterval({
        min_value: 2,
        open_at_min: true,
        max_value: 3,
        open_at_max: true,
      }),
    ).toEqual({minValue: 2, openAtMin: true, maxValue: 3, openAtMax: true});
  });

  it('rejects an interval that names no upper end', () => {
    expect(() => parseInterval({min_value: 0})).toThrow(
      /Invalid Interval: maxValue: /,
    );
  });
});

describe('parseMetricValueInfo', () => {
  it('leaves the interval undefined when the payload names none', () => {
    expect(parseMetricValueInfo({})).toEqual({});
  });

  it('validates a supplied interval', () => {
    expect(
      parseMetricValueInfo({interval: {min_value: 1, max_value: 5}}),
    ).toEqual({
      interval: {minValue: 1, openAtMin: false, maxValue: 5, openAtMax: false},
    });
  });
});

describe('parseMetricInfo', () => {
  it('reads the adk-python spelling of every field', () => {
    expect(
      parseMetricInfo({
        metric_name: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
        description: 'Compares the actual tool calls with the expected ones.',
        metric_value_info: {interval: {min_value: 0, max_value: 1}},
      }),
    ).toEqual({
      metricName: 'tool_trajectory_avg_score',
      description: 'Compares the actual tool calls with the expected ones.',
      metricValueInfo: {
        interval: {
          minValue: 0,
          openAtMin: false,
          maxValue: 1,
          openAtMax: false,
        },
      },
    });
  });

  it('leaves the description undefined when the payload names none', () => {
    expect(
      parseMetricInfo({metric_name: 'x', metric_value_info: {}}).description,
    ).toBeUndefined();
  });

  it('rejects a metric info that names no value info', () => {
    expect(() => parseMetricInfo({metric_name: 'x'})).toThrow(
      /Invalid MetricInfo: metricValueInfo: /,
    );
  });

  it('rejects a metric info that names no metric name', () => {
    expect(() => parseMetricInfo({metric_value_info: {}})).toThrow(
      /Invalid MetricInfo: metricName: /,
    );
  });
});

/** Modelled on adk-python's `TrajectoryEvaluatorMetricInfoProvider`. */
class TrajectoryMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return {
      metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      description: 'Compares the actual tool calls with the expected ones.',
      metricValueInfo: {
        interval: {
          minValue: 0,
          openAtMin: false,
          maxValue: 1,
          openAtMax: false,
        },
      },
    };
  }
}

describe('MetricInfoProvider', () => {
  it('describes the metric it owns', () => {
    const metricInfo = new TrajectoryMetricInfoProvider().getMetricInfo();

    expect(metricInfo.metricName).toBe(
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    );
    expect(metricInfo.metricValueInfo.interval?.minValue).toBe(0);
    expect(metricInfo.metricValueInfo.interval?.maxValue).toBe(1);
  });
});

describe('the rubric re-exports', () => {
  it('type-check as the rubrics of a rubric based criterion', () => {
    const rubric: Rubric = {
      rubricId: 'grammar',
      rubricContent: {textProperty: 'The response is grammatical.'},
    };
    const criterion: RubricsBasedCriterion = {
      threshold: 0.7,
      includeIntermediateResponsesInFinal: false,
      judgeModelOptions: JUDGE_MODEL_DEFAULTS,
      rubrics: [rubric],
    };

    expect(criterion.rubrics?.[0]).toBe(rubric);
  });
});

describe('the final_response_match_v2 threshold', () => {
  it('prefers the criterion threshold over the metric one', () => {
    expect(
      getMetricThreshold({
        metricName: PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
        threshold: 0.8,
        criterion: {threshold: 0.5},
      }),
    ).toBe(0.5);
  });

  it('falls back to the deprecated metric threshold', () => {
    expect(
      getMetricThreshold({
        metricName: PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
        threshold: 0.8,
      }),
    ).toBe(0.8);
  });

  it('rejects a metric that carries no threshold at all', () => {
    expect(() =>
      getMetricThreshold({
        metricName: PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
      }),
    ).toThrow(InputValidationError);
  });
});
