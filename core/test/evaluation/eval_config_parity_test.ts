/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python
// tests/unittests/evaluation/test_eval_config.py @ main (6e596635).
//
// Each test keeps the reference test's name so a reader can find the original.

import {
  DEFAULT_EVAL_CONFIG,
  getConfigCustomFunctionPath,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
  parseEvalConfig,
  type EvalConfig,
  type LlmBackedUserSimulatorConfig,
  type Rubric,
} from '@google/adk';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adk-eval-config-parity-'));
  const configPath = join(dir, 'test_config.json');
  await writeFile(configPath, contents, 'utf-8');
  return configPath;
}

/** Returns the simulator section, failing the test when it is not present. */
function requireLlmBackedSimulator(
  config: EvalConfig,
): LlmBackedUserSimulatorConfig {
  const simulator = config.userSimulatorConfig;
  if (simulator?.type !== 'llm_backed') {
    expect.fail(`expected an llm_backed simulator, got ${simulator?.type}`);
  }
  return simulator;
}

describe('eval config parity', () => {
  it('test_get_evaluation_criteria_or_default_returns_default', async () => {
    expect(await getEvaluationCriteriaOrDefault('')).toBe(DEFAULT_EVAL_CONFIG);
  });

  it('test_get_evaluation_criteria_or_default_reads_from_file', async () => {
    const configPath = await writeConfig(
      JSON.stringify({
        criteria: {tool_trajectory_avg_score: 0.5, response_match_score: 0.5},
      }),
    );

    expect(await getEvaluationCriteriaOrDefault(configPath)).toEqual({
      criteria: {tool_trajectory_avg_score: 0.5, response_match_score: 0.5},
    });
  });

  it('test_get_evaluation_criteria_or_default_returns_default_if_file_not_found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-eval-config-parity-'));

    expect(await getEvaluationCriteriaOrDefault(join(dir, 'absent.json'))).toBe(
      DEFAULT_EVAL_CONFIG,
    );
  });

  it('test_get_eval_metrics_from_config', () => {
    const rubric: Rubric = {
      rubricId: 'test-rubric',
      rubricContent: {textProperty: 'test'},
    };
    const evalConfig = parseEvalConfig({
      criteria: {
        tool_trajectory_avg_score: 1.0,
        response_match_score: 0.8,
        final_response_match_v2: {
          threshold: 0.5,
          judge_model_options: {judge_model: 'gemini-pro', num_samples: 1},
        },
        rubric_based_final_response_quality_v1: {
          threshold: 0.9,
          judge_model_options: {judge_model: 'gemini-ultra', num_samples: 1},
          rubrics: [rubric],
        },
      },
    });

    const evalMetrics = getEvalMetricsFromConfig(evalConfig);

    expect(evalMetrics).toHaveLength(4);
    expect(evalMetrics[0].metricName).toBe('tool_trajectory_avg_score');
    expect(evalMetrics[0].threshold).toBe(1.0);
    expect(evalMetrics[0].criterion).toEqual({threshold: 1.0});
    expect(evalMetrics[1].metricName).toBe('response_match_score');
    expect(evalMetrics[1].criterion).toEqual({threshold: 0.8});
    expect(evalMetrics[2].metricName).toBe('final_response_match_v2');
    expect(evalMetrics[2].criterion).toEqual({
      threshold: 0.5,
      judgeModelOptions: {judgeModel: 'gemini-pro', numSamples: 1},
    });
    expect(evalMetrics[3].metricName).toBe(
      'rubric_based_final_response_quality_v1',
    );
    expect(evalMetrics[3].criterion).toEqual({
      threshold: 0.9,
      judgeModelOptions: {judgeModel: 'gemini-ultra', numSamples: 1},
      rubrics: [rubric],
    });
  });

  it('test_get_eval_metrics_from_config_with_custom_metrics', () => {
    const evalConfig = parseEvalConfig({
      criteria: {custom_metric_1: 1.0, custom_metric_2: {threshold: 0.5}},
      custom_metrics: {
        custom_metric_1: {code_config: {name: 'path/to/custom/metric_1'}},
        custom_metric_2: {code_config: {name: 'path/to/custom/metric_2'}},
      },
    });

    const evalMetrics = getEvalMetricsFromConfig(evalConfig);

    expect(evalMetrics).toHaveLength(2);
    expect(evalMetrics[0].metricName).toBe('custom_metric_1');
    expect(evalMetrics[0].threshold).toBe(1.0);
    expect(evalMetrics[0].customFunctionPath).toBe('path/to/custom/metric_1');
    expect(getConfigCustomFunctionPath(evalMetrics[0])).toBe(
      'path/to/custom/metric_1',
    );
    expect(evalMetrics[1].metricName).toBe('custom_metric_2');
    expect(evalMetrics[1].threshold).toBe(0.5);
    expect(evalMetrics[1].customFunctionPath).toBe('path/to/custom/metric_2');
    expect(getConfigCustomFunctionPath(evalMetrics[1])).toBe(
      'path/to/custom/metric_2',
    );
  });

  it('test_get_eval_metrics_from_config_empty_criteria', () => {
    expect(getEvalMetricsFromConfig(parseEvalConfig({criteria: {}}))).toEqual(
      [],
    );
  });

  it('test_eval_metric_criterion_survives_json_round_trip', () => {
    const evalMetric = getEvalMetricsFromConfig(
      parseEvalConfig({
        criteria: {
          final_response_match_v2: {
            threshold: 0.8,
            judge_model_options: {judge_model: 'my-judge'},
          },
        },
      }),
    )[0];

    const restored: unknown = JSON.parse(JSON.stringify(evalMetric));

    expect(restored).toEqual({
      metricName: 'final_response_match_v2',
      threshold: 0.8,
      criterion: {
        threshold: 0.8,
        judgeModelOptions: {judgeModel: 'my-judge'},
      },
    });
  });

  it('test_eval_config_dump_preserves_concrete_criterion_fields', () => {
    const evalConfig = parseEvalConfig({
      criteria: {
        tool_trajectory_avg_score: 1.0,
        final_response_match_v2: {
          threshold: 0.8,
          judge_model_options: {judge_model: 'my-judge'},
        },
      },
    });

    const restored = parseEvalConfig(JSON.parse(JSON.stringify(evalConfig)));

    expect(restored.criteria['tool_trajectory_avg_score']).toBe(1.0);
    expect(restored.criteria['final_response_match_v2']).toEqual({
      threshold: 0.8,
      judgeModelOptions: {judgeModel: 'my-judge'},
    });
  });

  it('test_user_simulator_config_default_is_none', () => {
    expect(parseEvalConfig({}).userSimulatorConfig).toBeUndefined();
  });

  it('test_user_simulator_config_json_with_explicit_type', () => {
    const evalConfig = parseEvalConfig(
      JSON.parse(
        '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
          ' "userSimulatorConfig": {"type": "llm_backed",' +
          ' "model": "my-model", "maxAllowedInvocations": 5}}',
      ),
    );

    const simulator = requireLlmBackedSimulator(evalConfig);
    expect(simulator.type).toBe('llm_backed');
    expect(simulator.model).toBe('my-model');
    expect(simulator.maxAllowedInvocations).toBe(5);
  });

  it('test_user_simulator_config_json_with_llm_audio_type', () => {
    const evalConfig = parseEvalConfig(
      JSON.parse(
        '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
          ' "userSimulatorConfig": {"type": "llm_audio",' +
          ' "model": "my-model", "maxAllowedInvocations": 5}}',
      ),
    );

    const simulator = evalConfig.userSimulatorConfig;
    if (simulator?.type !== 'llm_audio') {
      expect.fail(`expected an llm_audio simulator, got ${simulator?.type}`);
    }
    expect(simulator.model).toBe('my-model');
    expect(simulator.maxAllowedInvocations).toBe(5);
  });

  it('test_user_simulator_config_json_without_type_backward_compat', () => {
    const evalConfig = parseEvalConfig(
      JSON.parse(
        '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
          ' "userSimulatorConfig": {"model": "legacy-model"}}',
      ),
    );

    const simulator = requireLlmBackedSimulator(evalConfig);
    expect(simulator.type).toBe('llm_backed');
    expect(simulator.model).toBe('legacy-model');
  });

  it('test_user_simulator_config_json_without_type_snake_case', () => {
    const evalConfig = parseEvalConfig(
      JSON.parse(
        '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
          ' "user_simulator_config": {"model": "legacy-model-snake"}}',
      ),
    );

    expect(requireLlmBackedSimulator(evalConfig).model).toBe(
      'legacy-model-snake',
    );
  });

  it('test_user_simulator_config_json_with_explicit_null_type', () => {
    const evalConfig = parseEvalConfig(
      JSON.parse(
        '{"criteria": {},' +
          ' "userSimulatorConfig": {"type": null, "model": "explicit-null"}}',
      ),
    );

    const simulator = requireLlmBackedSimulator(evalConfig);
    expect(simulator.type).toBe('llm_backed');
    expect(simulator.model).toBe('explicit-null');
  });

  it('test_user_simulator_config_json_with_unknown_type_raises', () => {
    const raw: unknown = JSON.parse(
      '{"criteria": {}, "userSimulatorConfig": {"type": "typo_type_name"}}',
    );

    expect(() => parseEvalConfig(raw)).toThrowError();
  });

  it('test_user_simulator_config_round_trip_via_model_dump_json', () => {
    const original: EvalConfig = {
      criteria: {},
      userSimulatorConfig: {type: 'llm_backed', model: 'round-trip-model'},
    };

    const restored = parseEvalConfig(JSON.parse(JSON.stringify(original)));

    const simulator = requireLlmBackedSimulator(restored);
    expect(simulator.model).toBe('round-trip-model');
    expect(simulator.type).toBe('llm_backed');
  });

  it('test_user_simulator_config_python_construction', () => {
    const evalConfig: EvalConfig = {
      criteria: {},
      userSimulatorConfig: {type: 'llm_backed', model: 'py-model'},
    };

    expect(requireLlmBackedSimulator(evalConfig).model).toBe('py-model');
  });

  it('test_live_model_config_defaults_to_none', () => {
    expect(parseEvalConfig({criteria: {}}).liveModelConfig).toBeUndefined();
  });

  it('test_live_model_config_from_json', () => {
    const evalConfig = parseEvalConfig({
      criteria: {},
      liveModelConfig: {timeoutSeconds: 600},
    });

    expect(evalConfig.liveModelConfig?.timeoutSeconds).toBe(600);
  });

  it('applies the live timeout default when the section omits it', () => {
    expect(parseEvalConfig({liveModelConfig: {}}).liveModelConfig).toEqual({
      timeoutSeconds: 300,
    });
  });
});
