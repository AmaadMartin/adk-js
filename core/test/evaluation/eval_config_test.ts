/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_EVAL_CONFIG,
  getConfigCustomFunctionPath,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
  getLogger,
  parseEvalConfig,
  setLogger,
  type Criterion,
  type EvalConfig,
  type LlmAudioUserSimulatorConfig,
  type LlmBackedUserSimulatorConfig,
  type Logger,
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

/** Installs a logger that records the info messages, until `restore`. */
function captureInfoMessages(): {messages: string[]; restore: () => void} {
  const previous = getLogger();
  const messages: string[] = [];
  const recorder: Logger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: (...args: unknown[]) => {
      messages.push(args.join(' '));
    },
    warn: () => {},
    error: () => {},
  };
  setLogger(recorder);
  return {messages, restore: () => setLogger(previous)};
}

/**
 * Builds a config whose criterion is out of type.
 *
 * The cast is the test input. `getEvalMetricsFromConfig` is public and takes a
 * config a caller may have built in code, so its guard has to hold for a value
 * the TypeScript type does not allow.
 */
function configWithCriterion(criterion: unknown): EvalConfig {
  return {criteria: {my_metric: criterion as Criterion}};
}

const VALID_CUSTOM_INSTRUCTIONS =
  'Stop with {{ stop_signal }}. Follow {{ conversation_plan }} given ' +
  '{{ conversation_history }}.';

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
      model: 'gemini-2.5-flash',
      modelConfiguration: {
        thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
      },
      maxAllowedInvocations: 4,
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
    [
      'a custom metric whose code_config carries an unknown key',
      {custom_metrics: {m: {code_config: {name: 'x', args: []}}}},
    ],
    [
      'a simulator config whose type names no simulator',
      {userSimulatorConfig: {type: 'typo_type_name'}},
    ],
    [
      'custom instructions that omit a placeholder',
      {
        userSimulatorConfig: {
          type: 'llm_backed',
          customInstructions: 'Stop with {{ stop_signal }}.',
        },
      },
    ],
    [
      'a metric info with no metric_name',
      {
        custom_metrics: {
          m: {code_config: {name: 'x'}, metric_info: {metric_value_info: {}}},
        },
      },
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

  it('records the custom function path off the metric object', () => {
    const metrics = getEvalMetricsFromConfig({
      criteria: {my_metric: 0.5, plain_metric: 0.5},
      customMetrics: {my_metric: {codeConfig: {name: './metrics.js#score'}}},
    });

    expect(getConfigCustomFunctionPath(metrics[0])).toBe('./metrics.js#score');
    expect(getConfigCustomFunctionPath(metrics[1])).toBeUndefined();
  });

  it.each([
    ['a string', 'x'],
    ['null', null],
    ['an array', [0.5]],
    ['an object with no threshold', {}],
  ])('rejects a criterion that is %s', (_name, criterion) => {
    expect(() =>
      getEvalMetricsFromConfig(configWithCriterion(criterion)),
    ).toThrowError(/Unexpected criterion type for metric 'my_metric'/);
  });

  it.each([
    ['string', 'x'],
    ['null', null],
    ['array', [0.5]],
  ])('names %s as the offending criterion type', (typeName, criterion) => {
    expect(() =>
      getEvalMetricsFromConfig(configWithCriterion(criterion)),
    ).toThrowError(new RegExp(`${typeName} not supported`));
  });
});

describe('parseEvalConfig key casing', () => {
  it.each([
    ['camelCase', {customMetrics: {m: {codeConfig: {name: 'x'}}}}],
    ['snake_case', {custom_metrics: {m: {code_config: {name: 'x'}}}}],
  ])('reads the custom metrics written in %s', (_name, raw) => {
    expect(parseEvalConfig(raw).customMetrics).toEqual({
      m: {codeConfig: {name: 'x'}},
    });
  });

  it.each([
    ['camelCase', {liveModelConfig: {timeoutSeconds: 600}}],
    ['snake_case', {live_model_config: {timeout_seconds: 600}}],
  ])('reads the live model config written in %s', (_name, raw) => {
    expect(parseEvalConfig(raw).liveModelConfig).toEqual({
      timeoutSeconds: 600,
    });
  });

  it.each([
    [
      'camelCase',
      {
        customMetrics: {
          m: {
            codeConfig: {name: 'x'},
            metricInfo: {
              metricName: 'm',
              description: 'My metric.',
              metricValueInfo: {interval: {minValue: -10, maxValue: 10}},
            },
          },
        },
      },
    ],
    [
      'snake_case',
      {
        custom_metrics: {
          m: {
            code_config: {name: 'x'},
            metric_info: {
              metric_name: 'm',
              description: 'My metric.',
              metric_value_info: {interval: {min_value: -10, max_value: 10}},
            },
          },
        },
      },
    ],
  ])('reads the metric info written in %s', (_name, raw) => {
    expect(parseEvalConfig(raw).customMetrics?.['m'].metricInfo).toEqual({
      metricName: 'm',
      description: 'My metric.',
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

  it('leaves the metric info out when the config omits it', () => {
    const config = parseEvalConfig({
      customMetrics: {m: {codeConfig: {name: 'x'}}},
    });

    expect(config.customMetrics?.['m'].metricInfo).toBeUndefined();
  });

  it('never converts a metric name', () => {
    const config = parseEvalConfig({
      criteria: {tool_trajectory_avg_score: 1.0},
      customMetrics: {my_custom_metric: {codeConfig: {name: 'x'}}},
    });

    expect(Object.keys(config.criteria)).toEqual(['tool_trajectory_avg_score']);
    expect(Object.keys(config.customMetrics ?? {})).toEqual([
      'my_custom_metric',
    ]);
  });
});

describe('parseEvalConfig user simulator section', () => {
  it('applies the audio simulator defaults', () => {
    const config = parseEvalConfig({
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

  it('keeps a setting the config shape does not name', () => {
    const config = parseEvalConfig({
      userSimulatorConfig: {type: 'llm_backed', myOwnSetting: 7},
    });

    expect(config.userSimulatorConfig?.['myOwnSetting']).toBe(7);
  });

  it('accepts custom instructions that name every placeholder', () => {
    const config = parseEvalConfig({
      userSimulatorConfig: {
        type: 'llm_backed',
        custom_instructions: VALID_CUSTOM_INSTRUCTIONS,
      },
    });

    expect(config.userSimulatorConfig?.customInstructions).toBe(
      VALID_CUSTOM_INSTRUCTIONS,
    );
  });

  it('logs once per section when it defaults the legacy type', () => {
    const captured = captureInfoMessages();
    try {
      parseEvalConfig({userSimulatorConfig: {model: 'legacy-model'}});
    } finally {
      captured.restore();
    }

    expect(captured.messages).toHaveLength(1);
    expect(captured.messages[0]).toContain(
      'eval_config.userSimulatorConfig has no `type` discriminator',
    );
  });

  it('says nothing when the section names its type', () => {
    const captured = captureInfoMessages();
    try {
      parseEvalConfig({userSimulatorConfig: {type: 'llm_backed'}});
    } finally {
      captured.restore();
    }

    expect(captured.messages).toEqual([]);
  });

  it('lists the supported types when it rejects an unknown one', () => {
    expect(() =>
      parseEvalConfig({userSimulatorConfig: {type: 'typo_type_name'}}),
    ).toThrowError(/supported types are 'llm_backed' and 'llm_audio'/);
  });

  it('rejects a section that is not an object', () => {
    expect(() => parseEvalConfig({userSimulatorConfig: 5})).toThrowError(
      /names a user simulator of type undefined/,
    );
  });
});

describe('an eval config written for adk-python', () => {
  it('loads with every section this SDK understands', async () => {
    const configPath = await writeConfig(
      JSON.stringify({
        criteria: {
          tool_trajectory_avg_score: 1.0,
          final_response_match_v2: {
            threshold: 0.5,
            judge_model_options: {
              judge_model: 'gemini-2.5-pro',
              num_samples: 3,
            },
          },
          my_custom_metric: 0.7,
        },
        customMetrics: {
          my_custom_metric: {
            codeConfig: {name: './metrics.js#score'},
            metricInfo: {
              metricName: 'my_custom_metric',
              description: 'My custom metric.',
              metricValueInfo: {interval: {minValue: -10.0, maxValue: 10.0}},
            },
          },
        },
        userSimulatorConfig: {type: 'llm_backed', model: 'gemini-2.5-flash'},
        liveModelConfig: {timeoutSeconds: 600},
      }),
    );

    const config = await getEvaluationCriteriaOrDefault(configPath);

    expect(config.liveModelConfig?.timeoutSeconds).toBe(600);
    expect(
      config.customMetrics?.['my_custom_metric'].metricInfo?.metricName,
    ).toBe('my_custom_metric');
    const simulator = config.userSimulatorConfig;
    if (simulator?.type !== 'llm_backed') {
      expect.fail(`expected an llm_backed simulator, got ${simulator?.type}`);
    }
    const llmBacked: LlmBackedUserSimulatorConfig = simulator;
    expect(llmBacked.model).toBe('gemini-2.5-flash');
    expect(getEvalMetricsFromConfig(config).map((m) => m.metricName)).toEqual([
      'tool_trajectory_avg_score',
      'final_response_match_v2',
      'my_custom_metric',
    ]);
  });

  it('narrows an audio section to its own config type', () => {
    const config = parseEvalConfig({
      userSimulatorConfig: {type: 'llm_audio', audio_model: 'my-tts'},
    });

    const simulator = config.userSimulatorConfig;
    if (simulator?.type !== 'llm_audio') {
      expect.fail(`expected an llm_audio simulator, got ${simulator?.type}`);
    }
    const audio: LlmAudioUserSimulatorConfig = simulator;
    expect(audio.audioModel).toBe('my-tts');
  });
});
