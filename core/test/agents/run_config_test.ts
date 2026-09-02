/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createTelemetryConfig, ToolThreadPoolConfig} from '@google/adk';
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
