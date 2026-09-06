/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AvatarConfig,
  HttpOptions,
  SessionResumptionConfig,
  TranslationConfig,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
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

  it('throws when streamingMode is StreamingMode.BIDI', () => {
    expect(() => createRunConfig({streamingMode: StreamingMode.BIDI})).toThrow(
      'StreamingMode.BIDI is not supported; use StreamingMode.SSE.',
    );
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
});
