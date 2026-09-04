/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the slice of `eval_metrics.ts` that
 * `PerTurnUserSimulatorQualityV1` reads. The module is vendored from the
 * `parity` branch, where it carries its own full test file.
 */

import {InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  getMetricThreshold,
  parseLlmBackedUserSimulatorCriterion,
} from '../../src/evaluation/eval_metrics.js';

describe('parseLlmBackedUserSimulatorCriterion', () => {
  it('applies the stop signal and judge model defaults', () => {
    expect(parseLlmBackedUserSimulatorCriterion({threshold: 0.8})).toEqual({
      threshold: 0.8,
      stopSignal: DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
      judgeModelOptions: {
        judgeModel: DEFAULT_JUDGE_MODEL,
        numSamples: DEFAULT_JUDGE_NUM_SAMPLES,
        parallelismLimit: DEFAULT_JUDGE_PARALLELISM_LIMIT,
      },
    });
  });

  it('rejects a sample count that is not a whole number', () => {
    expect(() =>
      parseLlmBackedUserSimulatorCriterion({
        threshold: 0.8,
        judgeModelOptions: {numSamples: 1.5},
      }),
    ).toThrow(/judgeModelOptions.numSamples: /);
  });

  it('rejects a parallelism limit that is not a whole number', () => {
    expect(() =>
      parseLlmBackedUserSimulatorCriterion({
        threshold: 0.8,
        judgeModelOptions: {parallelismLimit: 2.5},
      }),
    ).toThrow(/judgeModelOptions.parallelismLimit: /);
  });

  it('rejects a parallelism limit below one', () => {
    expect(() =>
      parseLlmBackedUserSimulatorCriterion({
        threshold: 0.8,
        judgeModelOptions: {parallelismLimit: 0},
      }),
    ).toThrow(/judgeModelOptions.parallelismLimit: /);
  });

  it('rejects a judge model option the schema does not name', () => {
    expect(() =>
      parseLlmBackedUserSimulatorCriterion({
        threshold: 0.8,
        judgeModelOptions: {temperature: 0.5},
      }),
    ).toThrow(/judgeModelOptions: /);
  });

  it('reads the adk-python spelling of every field', () => {
    const criterion = parseLlmBackedUserSimulatorCriterion({
      threshold: 0.8,
      stop_signal: '</done>',
      judge_model_options: {judge_model: 'gemini-2.5-pro', num_samples: 2},
    });

    expect(criterion.stopSignal).toBe('</done>');
    expect(criterion.judgeModelOptions?.judgeModel).toBe('gemini-2.5-pro');
    expect(criterion.judgeModelOptions?.numSamples).toBe(2);
  });

  it('names the field at fault when a field is invalid', () => {
    expect(() =>
      parseLlmBackedUserSimulatorCriterion({threshold: 'high'}),
    ).toThrow(/Invalid LlmBackedUserSimulatorCriterion: threshold: /);
  });

  it('rejects a payload that is not an object', () => {
    expect(() => parseLlmBackedUserSimulatorCriterion('nope')).toThrow(
      InputValidationError,
    );
  });
});

describe('getMetricThreshold', () => {
  it('prefers the criterion threshold over the deprecated metric one', () => {
    expect(
      getMetricThreshold({
        metricName: 'metric',
        threshold: 0.2,
        criterion: {threshold: 0.9},
      }),
    ).toBe(0.9);
  });

  it('falls back to the deprecated metric threshold', () => {
    expect(getMetricThreshold({metricName: 'metric', threshold: 0.2})).toBe(
      0.2,
    );
  });

  it('rejects a metric that names neither', () => {
    expect(() => getMetricThreshold({metricName: 'metric'})).toThrow(
      "Evaluation metric 'metric' requires a threshold.",
    );
  });
});
