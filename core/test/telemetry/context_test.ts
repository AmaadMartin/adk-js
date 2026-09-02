/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ContentCapturingMode,
  TelemetryConfig,
  createTelemetryConfig,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const IGNORE_RUN_CONFIG = 'ADK_TELEMETRY_IGNORE_RUN_CONFIG';
const SEMCONV_OPT_IN = 'OTEL_SEMCONV_STABILITY_OPT_IN';
const CAPTURE_MESSAGE_CONTENT =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const CAPTURE_CONTENT_IN_SPANS = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';
const EXPERIMENTAL_TELEMETRY = 'ADK_EXPERIMENTAL_TELEMETRY';

/** Clears every env var this module reads, so a test starts from the default. */
function clearTelemetryEnv(): void {
  for (const envVar of [
    IGNORE_RUN_CONFIG,
    SEMCONV_OPT_IN,
    CAPTURE_MESSAGE_CONTENT,
    CAPTURE_CONTENT_IN_SPANS,
    EXPERIMENTAL_TELEMETRY,
  ]) {
    vi.stubEnv(envVar, undefined);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTelemetryConfig', () => {
  it('returns a TelemetryConfig carrying the given fields', () => {
    clearTelemetryEnv();
    const config = createTelemetryConfig({
      genaiSemconvStabilityOptIn: 'experimental',
      captureMessageContent: ContentCapturingMode.SPAN_ONLY,
      adkExperimentalTelemetryOptIn: true,
    });
    expect(config.genaiSemconvStabilityOptIn).toBe('experimental');
    expect(config.captureMessageContent).toBe(ContentCapturingMode.SPAN_ONLY);
    expect(config.adkExperimentalTelemetryOptIn).toBe(true);
  });

  it('resolves every knob to its default with no env and no fields', () => {
    clearTelemetryEnv();
    const config = new TelemetryConfig();
    expect(config.shouldUseExperimentalGenaiSemconv).toBe(false);
    expect(config.resolvedContentCapturingMode).toBe(
      ContentCapturingMode.NO_CONTENT,
    );
    expect(config.contentCapturingModeValue).toBe('');
    expect(config.shouldAddContentToLogs).toBe(false);
    expect(config.shouldAddContentToExperimentalSpans).toBe(false);
    expect(config.shouldEmitExperimentalTelemetry).toBe(false);
    // The one knob that defaults on.
    expect(config.shouldAddContentToLegacySpans).toBe(true);
  });
});

describe('TelemetryConfig.shouldUseExperimentalGenaiSemconv', () => {
  it('is true when the env list contains the experimental token', () => {
    clearTelemetryEnv();
    vi.stubEnv(SEMCONV_OPT_IN, 'a, gen_ai_latest_experimental ,b');
    expect(createTelemetryConfig().shouldUseExperimentalGenaiSemconv).toBe(
      true,
    );
  });

  it('is false when the env list holds unrelated tokens', () => {
    clearTelemetryEnv();
    vi.stubEnv(SEMCONV_OPT_IN, 'http,database');
    expect(createTelemetryConfig().shouldUseExperimentalGenaiSemconv).toBe(
      false,
    );
  });

  it('lets the per-request field opt in without the env var', () => {
    clearTelemetryEnv();
    const config = createTelemetryConfig({
      genaiSemconvStabilityOptIn: 'experimental',
    });
    expect(config.shouldUseExperimentalGenaiSemconv).toBe(true);
  });

  it('lets the per-request field opt out of the env var', () => {
    clearTelemetryEnv();
    vi.stubEnv(SEMCONV_OPT_IN, 'gen_ai_latest_experimental');
    const config = createTelemetryConfig({
      genaiSemconvStabilityOptIn: 'stable',
    });
    expect(config.shouldUseExperimentalGenaiSemconv).toBe(false);
  });

  it('ignores the per-request field under the admin lock', () => {
    clearTelemetryEnv();
    vi.stubEnv(IGNORE_RUN_CONFIG, '1');
    vi.stubEnv(SEMCONV_OPT_IN, 'gen_ai_latest_experimental');
    const config = createTelemetryConfig({
      genaiSemconvStabilityOptIn: 'stable',
    });
    expect(config.shouldUseExperimentalGenaiSemconv).toBe(true);
  });
});

describe('TelemetryConfig.resolvedContentCapturingMode', () => {
  it.each(['true', '1', 'TRUE'])(
    'reads the legacy boolean env value %s as EVENT_ONLY',
    (envValue) => {
      clearTelemetryEnv();
      vi.stubEnv(CAPTURE_MESSAGE_CONTENT, envValue);
      expect(createTelemetryConfig().resolvedContentCapturingMode).toBe(
        ContentCapturingMode.EVENT_ONLY,
      );
    },
  );

  it('reads a mode name case-insensitively', () => {
    clearTelemetryEnv();
    vi.stubEnv(CAPTURE_MESSAGE_CONTENT, ' span_only ');
    expect(createTelemetryConfig().resolvedContentCapturingMode).toBe(
      ContentCapturingMode.SPAN_ONLY,
    );
  });

  it('falls back to NO_CONTENT for an unknown env value', () => {
    clearTelemetryEnv();
    vi.stubEnv(CAPTURE_MESSAGE_CONTENT, 'garbage');
    expect(createTelemetryConfig().resolvedContentCapturingMode).toBe(
      ContentCapturingMode.NO_CONTENT,
    );
  });

  it('lets the per-request field override the env var', () => {
    clearTelemetryEnv();
    vi.stubEnv(CAPTURE_MESSAGE_CONTENT, 'true');
    const config = createTelemetryConfig({
      captureMessageContent: ContentCapturingMode.SPAN_AND_EVENT,
    });
    expect(config.resolvedContentCapturingMode).toBe(
      ContentCapturingMode.SPAN_AND_EVENT,
    );
  });

  it('ignores the per-request field under the admin lock', () => {
    clearTelemetryEnv();
    vi.stubEnv(IGNORE_RUN_CONFIG, 'true');
    vi.stubEnv(CAPTURE_MESSAGE_CONTENT, 'EVENT_ONLY');
    const config = createTelemetryConfig({
      captureMessageContent: ContentCapturingMode.SPAN_AND_EVENT,
    });
    expect(config.resolvedContentCapturingMode).toBe(
      ContentCapturingMode.EVENT_ONLY,
    );
  });

  it('reports the mode name for contentCapturingModeValue', () => {
    clearTelemetryEnv();
    const config = createTelemetryConfig({
      captureMessageContent: ContentCapturingMode.SPAN_ONLY,
    });
    expect(config.contentCapturingModeValue).toBe('SPAN_ONLY');
  });
});

describe('TelemetryConfig content routing', () => {
  it.each([
    [ContentCapturingMode.NO_CONTENT, false, false],
    [ContentCapturingMode.EVENT_ONLY, true, false],
    [ContentCapturingMode.SPAN_ONLY, false, true],
    [ContentCapturingMode.SPAN_AND_EVENT, true, true],
  ])('routes %s to logs=%s and experimental spans=%s', (mode, logs, spans) => {
    clearTelemetryEnv();
    const config = createTelemetryConfig({captureMessageContent: mode});
    expect(config.shouldAddContentToLogs).toBe(logs);
    expect(config.shouldAddContentToExperimentalSpans).toBe(spans);
  });
});

describe('TelemetryConfig.shouldAddContentToLegacySpans', () => {
  it.each(['false', '0', 'FALSE'])('is off for the env value %s', (value) => {
    clearTelemetryEnv();
    vi.stubEnv(CAPTURE_CONTENT_IN_SPANS, value);
    expect(createTelemetryConfig().shouldAddContentToLegacySpans).toBe(false);
  });

  it('stays on for an unrelated env value', () => {
    clearTelemetryEnv();
    vi.stubEnv(CAPTURE_CONTENT_IN_SPANS, 'yes');
    expect(createTelemetryConfig().shouldAddContentToLegacySpans).toBe(true);
  });

  it('follows span-bearing routing when the per-request field is set', () => {
    clearTelemetryEnv();
    const eventOnly = createTelemetryConfig({
      captureMessageContent: ContentCapturingMode.EVENT_ONLY,
    });
    const spanOnly = createTelemetryConfig({
      captureMessageContent: ContentCapturingMode.SPAN_ONLY,
    });
    expect(eventOnly.shouldAddContentToLegacySpans).toBe(false);
    expect(spanOnly.shouldAddContentToLegacySpans).toBe(true);
  });

  it('ignores the per-request field under the admin lock', () => {
    clearTelemetryEnv();
    vi.stubEnv(IGNORE_RUN_CONFIG, '1');
    const config = createTelemetryConfig({
      captureMessageContent: ContentCapturingMode.EVENT_ONLY,
    });
    expect(config.shouldAddContentToLegacySpans).toBe(true);
  });
});

describe('TelemetryConfig.shouldEmitExperimentalTelemetry', () => {
  it.each(['1', 'true'])('is on for the env value %s', (value) => {
    clearTelemetryEnv();
    vi.stubEnv(EXPERIMENTAL_TELEMETRY, value);
    expect(createTelemetryConfig().shouldEmitExperimentalTelemetry).toBe(true);
  });

  it('lets the per-request field opt in without the env var', () => {
    clearTelemetryEnv();
    const config = createTelemetryConfig({
      adkExperimentalTelemetryOptIn: true,
    });
    expect(config.shouldEmitExperimentalTelemetry).toBe(true);
  });

  it('lets the per-request field opt out of the env var', () => {
    clearTelemetryEnv();
    vi.stubEnv(EXPERIMENTAL_TELEMETRY, 'true');
    const config = createTelemetryConfig({
      adkExperimentalTelemetryOptIn: false,
    });
    expect(config.shouldEmitExperimentalTelemetry).toBe(false);
  });

  it('ignores the per-request field under the admin lock', () => {
    clearTelemetryEnv();
    vi.stubEnv(IGNORE_RUN_CONFIG, '1');
    vi.stubEnv(EXPERIMENTAL_TELEMETRY, 'true');
    const config = createTelemetryConfig({
      adkExperimentalTelemetryOptIn: false,
    });
    expect(config.shouldEmitExperimentalTelemetry).toBe(true);
  });
});

describe('TelemetryConfig environment snapshot', () => {
  it('keeps the environment it was constructed with', () => {
    clearTelemetryEnv();
    vi.stubEnv(EXPERIMENTAL_TELEMETRY, 'true');
    vi.stubEnv(CAPTURE_MESSAGE_CONTENT, 'SPAN_ONLY');
    const config = createTelemetryConfig();

    vi.stubEnv(EXPERIMENTAL_TELEMETRY, 'false');
    vi.stubEnv(CAPTURE_MESSAGE_CONTENT, 'EVENT_ONLY');
    vi.stubEnv(CAPTURE_CONTENT_IN_SPANS, 'false');

    expect(config.shouldEmitExperimentalTelemetry).toBe(true);
    expect(config.resolvedContentCapturingMode).toBe(
      ContentCapturingMode.SPAN_ONLY,
    );
    expect(config.shouldAddContentToLegacySpans).toBe(true);
  });
});
