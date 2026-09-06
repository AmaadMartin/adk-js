/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_EVAL_CONFIG,
  EvalConfig,
  getConfigCustomFunctionPath,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
  InputValidationError,
  parseEvalConfig,
  parseLlmBackedUserSimulatorConfig,
  Rubric,
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
      model: 'gemini-2.5-flash',
      modelConfiguration: {
        thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
      },
      includeFunctionCalls: false,
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
        threshold: 0.8,
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
        threshold: 0.5,
        criterion,
        customFunctionPath: './metrics.js#score',
      },
    ]);
  });

  it('returns nothing for a config with no criteria', () => {
    expect(getEvalMetricsFromConfig({criteria: {}})).toEqual([]);
  });
});

// Ported from adk-python tests/unittests/evaluation/test_eval_config.py @ main
describe('adk-python reference tests', () => {
  it('test_get_evaluation_criteria_or_default_returns_default', async () => {
    expect(await getEvaluationCriteriaOrDefault('')).toBe(DEFAULT_EVAL_CONFIG);
  });

  it('test_get_evaluation_criteria_or_default_reads_from_file', async () => {
    const evalConfig = parseEvalConfig({
      criteria: {tool_trajectory_avg_score: 0.5, response_match_score: 0.5},
    });
    const configPath = await writeConfig(JSON.stringify(evalConfig));

    expect(await getEvaluationCriteriaOrDefault(configPath)).toEqual(
      evalConfig,
    );
  });

  it('test_get_evaluation_criteria_or_default_returns_default_if_file_not_found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-eval-config-'));

    expect(await getEvaluationCriteriaOrDefault(join(dir, 'absent.json'))).toBe(
      DEFAULT_EVAL_CONFIG,
    );
  });

  it('test_get_eval_metrics_from_config', () => {
    const rubric1: Rubric = {
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
          rubrics: [rubric1],
        },
      },
    });

    const evalMetrics = getEvalMetricsFromConfig(evalConfig);

    expect(evalMetrics).toHaveLength(4);
    expect(evalMetrics[0].metricName).toBe('tool_trajectory_avg_score');
    expect(evalMetrics[0].threshold).toBe(1.0);
    expect(evalMetrics[0].criterion?.threshold).toBe(1.0);
    expect(evalMetrics[1].metricName).toBe('response_match_score');
    expect(evalMetrics[1].threshold).toBe(0.8);
    expect(evalMetrics[1].criterion?.threshold).toBe(0.8);
    expect(evalMetrics[2].metricName).toBe('final_response_match_v2');
    expect(evalMetrics[2].threshold).toBe(0.5);
    expect(evalMetrics[2].criterion).toEqual({
      threshold: 0.5,
      judgeModelOptions: {judgeModel: 'gemini-pro', numSamples: 1},
    });
    expect(evalMetrics[3].metricName).toBe(
      'rubric_based_final_response_quality_v1',
    );
    expect(evalMetrics[3].threshold).toBe(0.9);
    expect(evalMetrics[3].criterion).toEqual({
      threshold: 0.9,
      judgeModelOptions: {judgeModel: 'gemini-ultra', numSamples: 1},
      rubrics: [rubric1],
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
    expect(evalMetrics[0].criterion?.threshold).toBe(1.0);
    expect(evalMetrics[0].customFunctionPath).toBe('path/to/custom/metric_1');
    expect(evalMetrics[1].metricName).toBe('custom_metric_2');
    expect(evalMetrics[1].threshold).toBe(0.5);
    expect(evalMetrics[1].criterion?.threshold).toBe(0.5);
    expect(evalMetrics[1].customFunctionPath).toBe('path/to/custom/metric_2');
  });

  it('test_get_eval_metrics_from_config_empty_criteria', () => {
    expect(getEvalMetricsFromConfig(parseEvalConfig({criteria: {}}))).toEqual(
      [],
    );
  });

  it('test_eval_config_dump_preserves_concrete_criterion_fields', () => {
    const evalConfig = parseEvalConfig({
      criteria: {
        tool_trajectory_avg_score: 1.0,
        final_response_match_v2: {
          threshold: 0.8,
          judgeModelOptions: {judgeModel: 'my-judge'},
        },
      },
    });

    const restored = parseEvalConfig(JSON.parse(JSON.stringify(evalConfig)));

    expect(restored.criteria['tool_trajectory_avg_score']).toBe(1.0);
    const criterion = restored.criteria['final_response_match_v2'];
    expect(criterion).toEqual({
      threshold: 0.8,
      judgeModelOptions: {judgeModel: 'my-judge'},
    });
  });

  it('test_user_simulator_config_default_is_none', () => {
    expect(parseEvalConfig({}).userSimulatorConfig).toBeUndefined();
  });

  it('test_user_simulator_config_json_with_explicit_type', () => {
    const payload =
      '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
      ' "userSimulatorConfig": {"type": "llm_backed",' +
      ' "model": "my-model", "maxAllowedInvocations": 5}}';

    const simulator = parseEvalConfig(JSON.parse(payload)).userSimulatorConfig;

    expect(simulator?.type).toBe('llm_backed');
    expect(simulator?.model).toBe('my-model');
    expect(simulator?.maxAllowedInvocations).toBe(5);
  });

  it('test_user_simulator_config_json_with_llm_audio_type', () => {
    const payload =
      '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
      ' "userSimulatorConfig": {"type": "llm_audio",' +
      ' "model": "my-model", "maxAllowedInvocations": 5}}';

    const simulator = parseEvalConfig(JSON.parse(payload)).userSimulatorConfig;

    expect(simulator?.type).toBe('llm_audio');
    expect(simulator?.model).toBe('my-model');
    expect(simulator?.maxAllowedInvocations).toBe(5);
  });

  it('test_user_simulator_config_json_without_type_backward_compat', () => {
    const payload =
      '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
      ' "userSimulatorConfig": {"model": "legacy-model"}}';

    const simulator = parseEvalConfig(JSON.parse(payload)).userSimulatorConfig;

    expect(simulator?.type).toBe('llm_backed');
    expect(simulator?.model).toBe('legacy-model');
  });

  it('test_user_simulator_config_json_without_type_snake_case', () => {
    const payload =
      '{"criteria": {"tool_trajectory_avg_score": 1.0},' +
      ' "user_simulator_config": {"model": "legacy-model-snake"}}';

    const simulator = parseEvalConfig(JSON.parse(payload)).userSimulatorConfig;

    expect(simulator?.type).toBe('llm_backed');
    expect(simulator?.model).toBe('legacy-model-snake');
  });

  it('test_user_simulator_config_json_with_explicit_null_type', () => {
    const payload =
      '{"criteria": {},' +
      ' "userSimulatorConfig": {"type": null, "model": "explicit-null"}}';

    const simulator = parseEvalConfig(JSON.parse(payload)).userSimulatorConfig;

    expect(simulator?.type).toBe('llm_backed');
    expect(simulator?.model).toBe('explicit-null');
  });

  it('test_user_simulator_config_json_with_unknown_type_raises', () => {
    const payload =
      '{"criteria": {}, "userSimulatorConfig": {"type": "typo_type_name"}}';

    expect(() => parseEvalConfig(JSON.parse(payload))).toThrowError(
      InputValidationError,
    );
  });

  it('test_user_simulator_config_round_trip_via_model_dump_json', () => {
    const original: EvalConfig = {
      criteria: {},
      userSimulatorConfig: parseLlmBackedUserSimulatorConfig({
        model: 'round-trip-model',
      }),
    };

    const restored = parseEvalConfig(JSON.parse(JSON.stringify(original)));

    expect(restored.userSimulatorConfig?.type).toBe('llm_backed');
    expect(restored.userSimulatorConfig?.model).toBe('round-trip-model');
  });

  it('test_live_model_config_defaults_to_none', () => {
    expect(parseEvalConfig({criteria: {}}).liveModelConfig).toBeUndefined();
  });

  it('test_live_model_config_from_json', () => {
    const evalConfig = parseEvalConfig({
      criteria: {},
      liveModelConfig: {timeoutSeconds: 600},
    });

    expect(evalConfig.liveModelConfig).toEqual({timeoutSeconds: 600});
  });
});

describe('parseEvalConfig, beyond the reference tests', () => {
  it('reads a metricInfo attached to a custom metric', () => {
    const config = parseEvalConfig({
      criteria: {my_metric: 0.5},
      customMetrics: {
        my_metric: {
          codeConfig: {name: './metrics.js#score'},
          metricInfo: {
            metricName: 'my_metric',
            description: 'My custom metric.',
            metricValueInfo: {interval: {minValue: -10, maxValue: 10}},
          },
        },
      },
    });

    expect(config.customMetrics?.['my_metric'].metricInfo).toEqual({
      metricName: 'my_metric',
      description: 'My custom metric.',
      metricValueInfo: {
        interval: {
          minValue: -10,
          maxValue: 10,
          openAtMin: false,
          openAtMax: false,
        },
      },
    });
  });

  it('rejects a metricInfo that names no metric', () => {
    expect(() =>
      parseEvalConfig({
        criteria: {},
        customMetrics: {
          my_metric: {
            codeConfig: {name: 'x'},
            metricInfo: {metricValueInfo: {}},
          },
        },
      }),
    ).toThrowError(/metricName/);
  });

  it('rejects a metricInfo that is not an object', () => {
    expect(() =>
      parseEvalConfig({
        criteria: {},
        customMetrics: {
          my_metric: {codeConfig: {name: 'x'}, metricInfo: 'not-an-object'},
        },
      }),
    ).toThrowError(/Invalid MetricInfo: .*expected object/);
  });

  it.each([
    ['an unknown key', {name: 'x', unexpected: 1}],
    ['an empty name', {name: ''}],
  ])('rejects a codeConfig with %s', (_name, codeConfig) => {
    expect(() =>
      parseEvalConfig({criteria: {}, customMetrics: {my_metric: {codeConfig}}}),
    ).toThrowError(InputValidationError);
  });

  const CUSTOM_METRICS = {customMetrics: {m: {codeConfig: {name: 'x'}}}};
  const SIMULATOR = {userSimulatorConfig: {type: 'llm_backed', model: 'm'}};
  const LIVE_MODEL = {liveModelConfig: {timeoutSeconds: 42}};

  it.each([
    ['customMetrics', CUSTOM_METRICS, CUSTOM_METRICS],
    [
      'custom_metrics',
      {custom_metrics: {m: {code_config: {name: 'x'}}}},
      CUSTOM_METRICS,
    ],
    ['userSimulatorConfig', {userSimulatorConfig: {model: 'm'}}, SIMULATOR],
    ['user_simulator_config', {user_simulator_config: {model: 'm'}}, SIMULATOR],
    ['liveModelConfig', LIVE_MODEL, LIVE_MODEL],
    [
      'live_model_config',
      {live_model_config: {timeout_seconds: 42}},
      LIVE_MODEL,
    ],
  ])('reads the top-level key %s', (_spelling, raw, expected) => {
    expect(parseEvalConfig({criteria: {}, ...raw})).toMatchObject(expected);
  });

  it('reads liveModelConfig.timeoutSeconds in either spelling', () => {
    expect(
      parseEvalConfig({criteria: {}, liveModelConfig: {timeout_seconds: 7}})
        .liveModelConfig,
    ).toEqual({timeoutSeconds: 7});
    expect(
      parseEvalConfig({criteria: {}, live_model_config: {timeoutSeconds: 7}})
        .liveModelConfig,
    ).toEqual({timeoutSeconds: 7});
  });

  it('applies every user simulator default', () => {
    const config = parseEvalConfig({
      criteria: {},
      userSimulatorConfig: {type: 'llm_backed'},
    });

    expect(config.userSimulatorConfig).toEqual({
      type: 'llm_backed',
      model: 'gemini-2.5-flash',
      modelConfiguration: {
        thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
      },
      maxAllowedInvocations: 20,
      includeFunctionCalls: false,
    });
  });

  it('applies every audio user simulator default', () => {
    const config = parseEvalConfig({
      criteria: {},
      userSimulatorConfig: {type: 'llm_audio'},
    });

    expect(config.userSimulatorConfig).toEqual({
      type: 'llm_audio',
      model: 'gemini-2.5-flash',
      modelConfiguration: {
        thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
      },
      maxAllowedInvocations: 20,
      includeFunctionCalls: false,
      audioModel: 'cloud_tts',
      audioModelConfiguration: {
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: 'en-US-Studio-O'}},
          languageCode: 'en-US',
        },
      },
      includeTextWithAudio: true,
    });
  });

  it('keeps a key a user simulator config does not name', () => {
    const config = parseEvalConfig({
      criteria: {},
      userSimulatorConfig: {type: 'llm_backed', my_own_setting: 'kept'},
    });

    expect(config.userSimulatorConfig).toMatchObject({myOwnSetting: 'kept'});
  });

  it('rejects a userSimulatorConfig that is not an object', () => {
    expect(() =>
      parseEvalConfig({criteria: {}, userSimulatorConfig: 'llm_backed'}),
    ).toThrowError(InputValidationError);
  });

  it('rejects a userSimulatorConfig whose type is not a string', () => {
    expect(() =>
      parseEvalConfig({criteria: {}, userSimulatorConfig: {type: 7}}),
    ).toThrowError(/unknown `type` 7. Accepted values: llm_backed, llm_audio/);
  });

  it('rejects a user simulator field of the wrong kind', () => {
    expect(() =>
      parseEvalConfig({
        criteria: {},
        userSimulatorConfig: {type: 'llm_backed', maxAllowedInvocations: 'few'},
      }),
    ).toThrowError(InputValidationError);
  });
});

describe('getEvalMetricsFromConfig, beyond the reference tests', () => {
  it('records the custom function path the config declared', () => {
    const metrics = getEvalMetricsFromConfig({
      criteria: {my_metric: 0.5, plain_metric: 0.5},
      customMetrics: {my_metric: {codeConfig: {name: './metrics.js#score'}}},
    });

    expect(getConfigCustomFunctionPath(metrics[0])).toBe('./metrics.js#score');
    expect(getConfigCustomFunctionPath(metrics[1])).toBeUndefined();
  });
});
