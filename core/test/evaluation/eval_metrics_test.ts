/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_JUDGE_MODEL,
  InputValidationError,
  getMetricThreshold,
  parseLlmAsAJudgeCriterion,
  parseRubricsBasedCriterion,
} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('parseLlmAsAJudgeCriterion', () => {
  it('applies every judge model default when the options are absent', () => {
    const criterion = parseLlmAsAJudgeCriterion({threshold: 0.5});

    expect(criterion).toEqual({
      threshold: 0.5,
      judgeModelOptions: {
        judgeModel: DEFAULT_JUDGE_MODEL,
        numSamples: 5,
        parallelismLimit: 1,
      },
    });
  });

  it('defaults only the judge model options the caller left out', () => {
    const criterion = parseLlmAsAJudgeCriterion({
      threshold: 0.7,
      judgeModelOptions: {numSamples: 3},
    });

    expect(criterion.judgeModelOptions).toEqual({
      judgeModel: DEFAULT_JUDGE_MODEL,
      numSamples: 3,
      parallelismLimit: 1,
    });
  });

  it('keeps the judge model config the caller supplied', () => {
    const judgeModelConfig: GenerateContentConfig = {temperature: 0.1};

    const criterion = parseLlmAsAJudgeCriterion({
      threshold: 0.5,
      judgeModelOptions: {judgeModelConfig},
    });

    expect(criterion.judgeModelOptions.judgeModelConfig).toBe(judgeModelConfig);
  });

  it('keeps the fields a concrete metric adds to the criterion', () => {
    const criterion = parseLlmAsAJudgeCriterion({
      threshold: 0.5,
      metricSpecificField: 'kept',
    });

    expect(criterion).toMatchObject({metricSpecificField: 'kept'});
  });

  it.each([0, -1])('rejects a parallelism limit of %i', (parallelismLimit) => {
    expect(() =>
      parseLlmAsAJudgeCriterion({
        threshold: 0.5,
        judgeModelOptions: {parallelismLimit},
      }),
    ).toThrow(InputValidationError);
  });

  it('rejects a criterion with no threshold', () => {
    expect(() => parseLlmAsAJudgeCriterion({})).toThrow(InputValidationError);
  });

  it('rejects an unknown judge model option', () => {
    expect(() =>
      parseLlmAsAJudgeCriterion({
        threshold: 0.5,
        judgeModelOptions: {numSample: 3},
      }),
    ).toThrow(/Invalid LlmAsAJudgeCriterion/);
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
    const criterion = parseRubricsBasedCriterion({threshold: 0.5});

    expect(criterion.rubrics).toEqual([]);
    expect(criterion.judgeModelOptions.numSamples).toBe(5);
  });

  it('keeps the rubrics the caller supplied', () => {
    const criterion = parseRubricsBasedCriterion({
      threshold: 0.5,
      rubrics: [
        {
          rubricId: 'r1',
          rubricContent: {textProperty: 'The answer is grammatical.'},
          type: 'FINAL_RESPONSE_QUALITY',
        },
      ],
    });

    expect(criterion.rubrics).toEqual([
      {
        rubricId: 'r1',
        rubricContent: {textProperty: 'The answer is grammatical.'},
        type: 'FINAL_RESPONSE_QUALITY',
      },
    ]);
  });

  it('rejects a rubric with no id', () => {
    expect(() =>
      parseRubricsBasedCriterion({
        threshold: 0.5,
        rubrics: [{rubricContent: {textProperty: 'anything'}}],
      }),
    ).toThrow(/Invalid RubricsBasedCriterion/);
  });

  it('names the criterion type it parses', () => {
    expect(parseRubricsBasedCriterion.criterionName).toBe(
      'RubricsBasedCriterion',
    );
  });
});

describe('getMetricThreshold', () => {
  it('prefers the criterion threshold over the metric one', () => {
    expect(
      getMetricThreshold({
        metricName: 'test_metric',
        threshold: 0.9,
        criterion: {threshold: 0.5},
      }),
    ).toBe(0.5);
  });

  it('falls back to the metric threshold when there is no criterion', () => {
    expect(
      getMetricThreshold({metricName: 'test_metric', threshold: 0.9}),
    ).toBe(0.9);
  });

  it('rejects a metric that carries neither', () => {
    expect(() => getMetricThreshold({metricName: 'test_metric'})).toThrow(
      "Evaluation metric 'test_metric' requires a threshold.",
    );
  });
});
