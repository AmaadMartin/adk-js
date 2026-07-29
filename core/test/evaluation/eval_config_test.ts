/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalConfigSchema,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
  type EvalConfig,
  type LlmAsAJudgeCriterion,
  type Rubric,
  type RubricsBasedCriterion,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

// The `userSimulatorConfig` discriminator tests from adk-python
// (`test_user_simulator_config_*`) are intentionally NOT ported here: the
// concrete discriminated user-simulator config union lives in
// `evaluation/simulation/` and is deferred to a later sub-port. `EvalConfig`
// carries `userSimulatorConfig` as an opaque passthrough until then.

const DEFAULT_CONFIG = EvalConfigSchema.parse({
  criteria: {
    tool_trajectory_avg_score: 1.0,
    response_match_score: 0.8,
  },
});

describe('evaluation/eval_config', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop()!;
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  function writeTempConfig(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-eval-config-'));
    createdDirs.push(dir);
    const filePath = path.join(dir, 'eval_config.json');
    fs.writeFileSync(filePath, contents, 'utf-8');
    return filePath;
  }

  describe('getEvaluationCriteriaOrDefault', () => {
    it('returns the default config for an empty path', () => {
      expect(getEvaluationCriteriaOrDefault('')).toEqual(DEFAULT_CONFIG);
    });

    it('returns the default config when no path is provided', () => {
      expect(getEvaluationCriteriaOrDefault()).toEqual(DEFAULT_CONFIG);
    });

    it('reads the config from a file when it exists', () => {
      const evalConfig = EvalConfigSchema.parse({
        criteria: {
          tool_trajectory_avg_score: 0.5,
          response_match_score: 0.5,
        },
      });
      const filePath = writeTempConfig(JSON.stringify(evalConfig));

      expect(getEvaluationCriteriaOrDefault(filePath)).toEqual(evalConfig);
    });

    it('returns the default config when the file does not exist', () => {
      const missing = path.join(
        os.tmpdir(),
        'adk-eval-config-missing-do-not-create.json',
      );

      expect(getEvaluationCriteriaOrDefault(missing)).toEqual(DEFAULT_CONFIG);
    });

    it('returns a fresh default so callers cannot poison later calls', () => {
      const first = getEvaluationCriteriaOrDefault('');
      first.criteria['injected_metric'] = 0.1;

      const second = getEvaluationCriteriaOrDefault('');

      expect(second.criteria['injected_metric']).toBeUndefined();
      expect(second).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('getEvalMetricsFromConfig', () => {
    it('maps threshold and criterion-object criteria into eval metrics', () => {
      const rubric: Rubric = {
        rubricId: 'test-rubric',
        rubricContent: {textProperty: 'test'},
      };
      const evalConfig = EvalConfigSchema.parse({
        criteria: {
          tool_trajectory_avg_score: 1.0,
          response_match_score: 0.8,
          final_response_match_v2: {
            threshold: 0.5,
            judgeModelOptions: {judgeModel: 'gemini-pro', numSamples: 1},
          },
          rubric_based_final_response_quality_v1: {
            threshold: 0.9,
            judgeModelOptions: {judgeModel: 'gemini-ultra', numSamples: 1},
            rubrics: [rubric],
          },
        },
      });

      const metrics = getEvalMetricsFromConfig(evalConfig);

      expect(metrics).toHaveLength(4);
      expect(metrics[0].metricName).toBe('tool_trajectory_avg_score');
      expect(metrics[0].threshold).toBe(1.0);
      expect(metrics[0].criterion?.threshold).toBe(1.0);
      expect(metrics[1].metricName).toBe('response_match_score');
      expect(metrics[1].threshold).toBe(0.8);
      expect(metrics[1].criterion?.threshold).toBe(0.8);

      expect(metrics[2].metricName).toBe('final_response_match_v2');
      expect(metrics[2].threshold).toBe(0.5);
      expect(metrics[2].criterion?.threshold).toBe(0.5);
      const judgeCriterion = metrics[2].criterion as LlmAsAJudgeCriterion;
      expect(judgeCriterion.judgeModelOptions.judgeModel).toBe('gemini-pro');

      expect(metrics[3].metricName).toBe(
        'rubric_based_final_response_quality_v1',
      );
      expect(metrics[3].threshold).toBe(0.9);
      expect(metrics[3].criterion?.threshold).toBe(0.9);
      const rubricCriterion = metrics[3].criterion as RubricsBasedCriterion;
      expect(rubricCriterion.judgeModelOptions.judgeModel).toBe('gemini-ultra');
      expect(rubricCriterion.rubrics).toHaveLength(1);
      expect(rubricCriterion.rubrics[0]).toEqual(rubric);
    });

    it('populates customFunctionPath from custom metrics', () => {
      const evalConfig = EvalConfigSchema.parse({
        criteria: {
          custom_metric_1: 1.0,
          custom_metric_2: {threshold: 0.5},
        },
        customMetrics: {
          custom_metric_1: {codeConfig: {name: 'path/to/custom/metric_1'}},
          custom_metric_2: {codeConfig: {name: 'path/to/custom/metric_2'}},
        },
      });

      const metrics = getEvalMetricsFromConfig(evalConfig);

      expect(metrics).toHaveLength(2);
      expect(metrics[0].metricName).toBe('custom_metric_1');
      expect(metrics[0].threshold).toBe(1.0);
      expect(metrics[0].criterion?.threshold).toBe(1.0);
      expect(metrics[0].customFunctionPath).toBe('path/to/custom/metric_1');
      expect(metrics[1].metricName).toBe('custom_metric_2');
      expect(metrics[1].threshold).toBe(0.5);
      expect(metrics[1].criterion?.threshold).toBe(0.5);
      expect(metrics[1].customFunctionPath).toBe('path/to/custom/metric_2');
    });

    it('leaves customFunctionPath undefined when a metric has no custom config', () => {
      const evalConfig = EvalConfigSchema.parse({
        criteria: {plain_metric: 0.7},
        customMetrics: {other_metric: {codeConfig: {name: 'unused'}}},
      });

      const metrics = getEvalMetricsFromConfig(evalConfig);

      expect(metrics).toHaveLength(1);
      expect(metrics[0].customFunctionPath).toBeUndefined();
    });

    it('returns an empty list for empty criteria', () => {
      const evalConfig = EvalConfigSchema.parse({criteria: {}});

      expect(getEvalMetricsFromConfig(evalConfig)).toEqual([]);
    });

    it('throws for an unexpected criterion type', () => {
      const evalConfig = {
        criteria: {bad_metric: 'not-a-valid-criterion'},
      } as unknown as EvalConfig;

      expect(() => getEvalMetricsFromConfig(evalConfig)).toThrow(
        /Unexpected criterion type/,
      );
    });
  });

  describe('LiveModelConfig', () => {
    it('defaults to absent on a bare EvalConfig', () => {
      const evalConfig = EvalConfigSchema.parse({criteria: {}});

      expect(evalConfig.liveModelConfig).toBeUndefined();
    });

    it('parses timeoutSeconds from JSON', () => {
      const evalConfig = EvalConfigSchema.parse({
        criteria: {},
        liveModelConfig: {timeoutSeconds: 600},
      });

      expect(evalConfig.liveModelConfig?.timeoutSeconds).toBe(600);
    });

    it('applies the default timeout when omitted', () => {
      const evalConfig = EvalConfigSchema.parse({
        criteria: {},
        liveModelConfig: {},
      });

      expect(evalConfig.liveModelConfig?.timeoutSeconds).toBe(300);
    });
  });
});
