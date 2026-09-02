/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createTelemetryConfig, ToolThreadPoolConfig} from '@google/adk';
import {
  AvatarConfig,
  createUserContent,
  HttpOptions,
  SessionResumptionConfig,
  TranslationConfig,
} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRunConfig, StreamingMode} from '../../src/agents/run_config.js';
import {logger} from '../../src/utils/logger.js';

describe('StreamingMode', () => {
  it('has NONE, SSE, and BIDI values', () => {
    expect(StreamingMode.NONE).toBe('none');
    expect(StreamingMode.SSE).toBe('sse');
    expect(StreamingMode.BIDI).toBe('bidi');
  });
});

describe('createRunConfig', () => {
  it('creates a RunConfig with all default values', () => {
    const config = createRunConfig();
    expect(config.saveInputBlobsAsArtifacts).toBe(false);
    expect(config.supportCfc).toBe(false);
    expect(config.enableAffectiveDialog).toBe(false);
    expect(config.streamingMode).toBe(StreamingMode.NONE);
    expect(config.maxLlmCalls).toBe(500);
    expect(config.pauseOnToolCalls).toBe(false);
  });

  it('overrides defaults with provided params', () => {
    const config = createRunConfig({
      saveInputBlobsAsArtifacts: true,
      supportCfc: true,
      streamingMode: StreamingMode.SSE,
      pauseOnToolCalls: true,
    });
    expect(config.saveInputBlobsAsArtifacts).toBe(true);
    expect(config.supportCfc).toBe(true);
    expect(config.streamingMode).toBe(StreamingMode.SSE);
    expect(config.pauseOnToolCalls).toBe(true);
  });

  it('uses provided maxLlmCalls when specified', () => {
    const config = createRunConfig({maxLlmCalls: 100});
    expect(config.maxLlmCalls).toBe(100);
  });

  it('accepts StreamingMode.BIDI', () => {
    expect(createRunConfig({streamingMode: StreamingMode.BIDI})).toMatchObject({
      streamingMode: StreamingMode.BIDI,
    });
  });

  it('logs a warning when maxLlmCalls is 0', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const config = createRunConfig({maxLlmCalls: 0});
    expect(config.maxLlmCalls).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('logs a warning when maxLlmCalls is negative', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const config = createRunConfig({maxLlmCalls: -1});
    expect(config.maxLlmCalls).toBe(-1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('uses the default when maxLlmCalls is explicitly undefined', () => {
    const config = createRunConfig({maxLlmCalls: undefined});
    expect(config.maxLlmCalls).toBe(500);
  });

  it('throws when maxLlmCalls exceeds Number.MAX_SAFE_INTEGER', () => {
    expect(() =>
      createRunConfig({maxLlmCalls: Number.MAX_SAFE_INTEGER + 1}),
    ).toThrow();
  });

  it('carries the request and live fields through without defaulting them', () => {
    const params = {
      httpOptions: {timeout: 5000},
      labels: {owner: 'run'},
      explicitVadSignal: true,
      translationConfig: {targetLanguageCode: 'es'},
      sessionResumption: {handle: 'resume-me'},
      avatarConfig: {avatarName: 'avatar-1'},
    };

    const config = createRunConfig(params);
    const defaults = createRunConfig();

    expect(config).toMatchObject(params);
    for (const field of Object.keys(params)) {
      expect(defaults).not.toHaveProperty(field);
    }
  });
});

describe('createRunConfig parity fields', () => {
  it('leaves every optional parity field undefined by default', () => {
    const config = createRunConfig();
    expect(config.httpOptions).toBeUndefined();
    expect(config.labels).toBeUndefined();
    expect(config.avatarConfig).toBeUndefined();
    expect(config.explicitVadSignal).toBeUndefined();
    expect(config.translationConfig).toBeUndefined();
    expect(config.sessionResumption).toBeUndefined();
    expect(config.historyConfig).toBeUndefined();
  });

  it('round-trips httpOptions and labels unchanged', () => {
    const httpOptions: HttpOptions = {
      timeout: 30_000,
      headers: {'x-request-id': 'req-1'},
    };
    const labels = {team: 'search', cost_center: 'abc-123'};

    const config = createRunConfig({httpOptions, labels});

    expect(config.httpOptions).toEqual(httpOptions);
    expect(config.labels).toEqual(labels);
  });

  it('round-trips the live-connect fields unchanged', () => {
    const translationConfig: TranslationConfig = {
      targetLanguageCode: 'es-ES',
    };
    const sessionResumption: SessionResumptionConfig = {transparent: true};

    const config = createRunConfig({
      explicitVadSignal: true,
      translationConfig,
      sessionResumption,
      historyConfig: {initialHistoryInClientContent: true},
    });

    expect(config.explicitVadSignal).toBe(true);
    expect(config.translationConfig).toEqual(translationConfig);
    expect(config.sessionResumption).toEqual(sessionResumption);
    expect(config.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    });
  });

  it('keeps a customized avatar intact', () => {
    const avatarConfig: AvatarConfig = {
      customizedAvatar: {
        imageMimeType: 'image/png',
        imageData: 'AAA=',
      },
      audioBitrateBps: 128_000,
    };

    const config = createRunConfig({avatarConfig});

    expect(config.avatarConfig).toEqual(avatarConfig);
  });

  it('keeps a named avatar intact', () => {
    const config = createRunConfig({avatarConfig: {avatarName: 'ada'}});

    expect(config.avatarConfig).toEqual({avatarName: 'ada'});
  });
});

describe('createRunConfig saveLiveBlob', () => {
  it('defaults saveLiveBlob to false', () => {
    expect(createRunConfig().saveLiveBlob).toBe(false);
  });

  it('preserves an explicit saveLiveBlob of true without warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const config = createRunConfig({saveLiveBlob: true});

    expect(config.saveLiveBlob).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('turns saveLiveBlob on and warns when saveLiveAudio is true', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const config = createRunConfig({saveLiveAudio: true});

    expect(config.saveLiveBlob).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('saveLiveAudio');
    warnSpy.mockRestore();
  });

  it('leaves saveLiveBlob off but still warns when saveLiveAudio is false', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const config = createRunConfig({saveLiveAudio: false});

    expect(config.saveLiveBlob).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('lets saveLiveAudio true override an explicit saveLiveBlob false', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const config = createRunConfig({saveLiveAudio: true, saveLiveBlob: false});

    expect(config.saveLiveBlob).toBe(true);
    warnSpy.mockRestore();
  });

  it('carries modelInputContext through unchanged', () => {
    const modelInputContext = [createUserContent('a retrieved document')];
    const config = createRunConfig({modelInputContext});
    expect(config.modelInputContext).toEqual(modelInputContext);
  });

  it('leaves modelInputContext unset by default', () => {
    expect(createRunConfig().modelInputContext).toBeUndefined();
  });
});

describe('createRunConfig with ADK_MAX_LLM_CALLS', () => {
  const originalEnvValue = process.env.ADK_MAX_LLM_CALLS;

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.ADK_MAX_LLM_CALLS;
    } else {
      process.env.ADK_MAX_LLM_CALLS = originalEnvValue;
    }
    vi.restoreAllMocks();
  });

  it('falls back to 500 when the env var is unset', () => {
    delete process.env.ADK_MAX_LLM_CALLS;
    expect(createRunConfig().maxLlmCalls).toBe(500);
  });

  it('reads the limit from the env var', () => {
    process.env.ADK_MAX_LLM_CALLS = '100';
    expect(createRunConfig().maxLlmCalls).toBe(100);
  });

  it('lets an explicit maxLlmCalls win over the env var', () => {
    process.env.ADK_MAX_LLM_CALLS = '100';
    expect(createRunConfig({maxLlmCalls: 200}).maxLlmCalls).toBe(200);
  });

  it('strips surrounding whitespace, as Python int() does', () => {
    process.env.ADK_MAX_LLM_CALLS = '  42  ';
    expect(createRunConfig().maxLlmCalls).toBe(42);
  });

  it('warns and falls back to 500 for a non-numeric env var', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.ADK_MAX_LLM_CALLS = 'invalid';
    expect(createRunConfig().maxLlmCalls).toBe(500);
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid value for ADK_MAX_LLM_CALLS env var: invalid. Using default 500.',
    );
  });

  it('warns and falls back to 500 for a fractional env var', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.ADK_MAX_LLM_CALLS = '1.5';
    expect(createRunConfig().maxLlmCalls).toBe(500);
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid value for ADK_MAX_LLM_CALLS env var: 1.5. Using default 500.',
    );
  });

  it('falls back to 500 without a warning for an empty env var', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.ADK_MAX_LLM_CALLS = '';
    expect(createRunConfig().maxLlmCalls).toBe(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns and falls back to 500 for a whitespace-only env var', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.ADK_MAX_LLM_CALLS = '   ';
    expect(createRunConfig().maxLlmCalls).toBe(500);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('accepts 0 from the env var and warns about the missing limit', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.ADK_MAX_LLM_CALLS = '0';
    expect(createRunConfig().maxLlmCalls).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain(
      'maxLlmCalls is less than or equal to 0',
    );
  });

  it('reads the env var on every call, not once per module load', () => {
    process.env.ADK_MAX_LLM_CALLS = '7';
    expect(createRunConfig().maxLlmCalls).toBe(7);
    process.env.ADK_MAX_LLM_CALLS = '9';
    expect(createRunConfig().maxLlmCalls).toBe(9);
  });
});

describe('createRunConfig audio transcription defaults', () => {
  it('defaults both transcription configs to an empty config', () => {
    const config = createRunConfig();
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
  });

  it('gives each config its own transcription objects', () => {
    const first = createRunConfig();
    const second = createRunConfig();
    expect(first.inputAudioTranscription).not.toBe(
      second.inputAudioTranscription,
    );
    expect(first.outputAudioTranscription).not.toBe(
      second.outputAudioTranscription,
    );
  });

  it('keeps an explicitly provided transcription config', () => {
    const inputAudioTranscription = {};
    const config = createRunConfig({inputAudioTranscription});
    expect(config.inputAudioTranscription).toBe(inputAudioTranscription);
  });
});

describe('createRunConfig parity fields', () => {
  it('returns the tool thread pool config unchanged', () => {
    const toolThreadPoolConfig: ToolThreadPoolConfig = {maxWorkers: 8};
    expect(createRunConfig({toolThreadPoolConfig}).toolThreadPoolConfig).toBe(
      toolThreadPoolConfig,
    );
  });

  it('returns customMetadata, getSessionConfig and modelInputContext as given', () => {
    const customMetadata = {tenant: 'acme'};
    const getSessionConfig = {numRecentEvents: 50};
    const modelInputContext = [
      {role: 'user', parts: [{text: 'Today is Tuesday.'}]},
    ];
    const config = createRunConfig({
      customMetadata,
      getSessionConfig,
      modelInputContext,
    });
    expect(config.customMetadata).toBe(customMetadata);
    expect(config.getSessionConfig).toBe(getSessionConfig);
    expect(config.modelInputContext).toBe(modelInputContext);
  });

  it('returns the telemetry config as given', () => {
    const telemetry = createTelemetryConfig();
    expect(createRunConfig({telemetry}).telemetry).toBe(telemetry);
  });
});
