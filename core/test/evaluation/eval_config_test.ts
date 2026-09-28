/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_EVAL_CONFIG,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
  parseEvalConfig,
} from '@google/adk';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adk-eval-config-'));
  const configPath = join(dir, 'test_config.json');
  await writeFile(configPath, contents, 'utf-8');
  return configPath;
}

describe('parseEvalConfig', () => {
  it('keeps metric names but converts the keys inside a criterion', () => {
    const config = parseEvalConfig({
      criteria: {
        tool_trajectory_avg_score: 1.0,
        final_response_match_v2: {
          threshold: 0.5,
          judge_model_options: {judge_model: 'gemini-2.5-flash'},
        },
      },
    });

    expect(config.criteria).toEqual({
      tool_trajectory_avg_score: 1.0,
      final_response_match_v2: {
        threshold: 0.5,
        judgeModelOptions: {judgeModel: 'gemini-2.5-flash'},
      },
    });
  });

  it('reads the custom metrics, the simulator config and the live config', () => {
    const config = parseEvalConfig({
      criteria: {},
      custom_metrics: {
        my_metric: {
          code_config: {name: './metrics.js#score'},
          description: 'My metric.',
        },
      },
      user_simulator_config: {type: 'llm_backed', max_allowed_invocations: 4},
      live_model_config: {timeout_seconds: 30},
    });

    expect(config.customMetrics).toEqual({
      my_metric: {
        codeConfig: {name: './metrics.js#score'},
        description: 'My metric.',
      },
    });
    expect(config.userSimulatorConfig).toEqual({
      type: 'llm_backed',
      maxAllowedInvocations: 4,
    });
    expect(config.liveModelConfig).toEqual({timeoutSeconds: 30});
  });

  it('defaults the live timeout and an absent description', () => {
    const config = parseEvalConfig({
      criteria: {},
      custom_metrics: {my_metric: {code_config: {name: 'x'}}},
      live_model_config: {},
    });

    expect(config.liveModelConfig).toEqual({timeoutSeconds: 300});
    expect(config.customMetrics?.['my_metric'].description).toBeUndefined();
  });

  it('leaves the optional sections out when the file omits them', () => {
    const config = parseEvalConfig({});

    expect(config).toEqual({
      criteria: {},
      customMetrics: undefined,
      userSimulatorConfig: undefined,
      liveModelConfig: undefined,
    });
  });

  it.each([
    ['a config that is not an object', 'x'],
    [
      'a criterion that is neither a number nor an object',
      {criteria: {m: 'x'}},
    ],
    ['a criterion object with no threshold', {criteria: {m: {}}}],
    ['a custom metric with no code_config', {custom_metrics: {m: {}}}],
    [
      'a custom metric whose code_config has no name',
      {custom_metrics: {m: {code_config: {}}}},
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseEvalConfig(raw)).toThrowError();
  });
});

describe('getEvaluationCriteriaOrDefault', () => {
  it('reads the config from the given path', async () => {
    const configPath = await writeConfig(
      '{"criteria": {"response_match_score": 0.4}}',
    );

    const config = await getEvaluationCriteriaOrDefault(configPath);

    expect(config.criteria).toEqual({response_match_score: 0.4});
  });

  it('falls back to the defaults when no path is supplied', async () => {
    expect(await getEvaluationCriteriaOrDefault()).toBe(DEFAULT_EVAL_CONFIG);
  });

  it('falls back to the defaults when the file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-eval-config-'));

    const config = await getEvaluationCriteriaOrDefault(
      join(dir, 'test_config.json'),
    );

    expect(config).toBe(DEFAULT_EVAL_CONFIG);
    expect(config.criteria).toEqual({
      tool_trajectory_avg_score: 1.0,
      response_match_score: 0.8,
    });
  });

  it('propagates a read failure that is not a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-eval-config-'));

    await expect(getEvaluationCriteriaOrDefault(dir)).rejects.toThrowError(
      /EISDIR/,
    );
  });
});

describe('getEvalMetricsFromConfig', () => {
  it('maps a bare threshold to a metric with a criterion', () => {
    const metrics = getEvalMetricsFromConfig({
      criteria: {response_match_score: 0.8},
    });

    expect(metrics).toEqual([
      {
        metricName: 'response_match_score',
        criterion: {threshold: 0.8},
        customFunctionPath: undefined,
      },
    ]);
  });

  it('keeps a criterion object and attaches the custom function path', () => {
    const criterion = {threshold: 0.5, judgeModelOptions: {numSamples: 3}};

    const metrics = getEvalMetricsFromConfig({
      criteria: {my_metric: criterion},
      customMetrics: {my_metric: {codeConfig: {name: './metrics.js#score'}}},
    });

    expect(metrics).toEqual([
      {
        metricName: 'my_metric',
        criterion,
        customFunctionPath: './metrics.js#score',
      },
    ]);
  });

  it('returns nothing for a config with no criteria', () => {
    expect(getEvalMetricsFromConfig({criteria: {}})).toEqual([]);
  });
});
