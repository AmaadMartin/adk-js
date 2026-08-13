/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {ContentCapturingMode} from '@google/adk';
import {
  ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS,
  ADK_TELEMETRY_IGNORE_RUN_CONFIG,
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
  TelemetryConfig,
  contentCapturingModeValue,
  resolveContentCapturingMode,
  shouldAddContentToExperimentalSpans,
  shouldAddContentToLegacySpans,
  shouldAddContentToLogs,
} from '../../src/telemetry/context.js';

const TELEMETRY_ENV_VARS = [
  ADK_TELEMETRY_IGNORE_RUN_CONFIG,
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
  ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS,
];

/**
 * Clears every telemetry variable, then applies the overrides, so an ambient
 * value on the developer machine cannot change a result.
 */
function setTelemetryEnv(overrides: Record<string, string | undefined> = {}) {
  for (const name of TELEMETRY_ENV_VARS) {
    vi.stubEnv(name, overrides[name]);
  }
}

function config(mode?: ContentCapturingMode): TelemetryConfig {
  return {captureMessageContent: mode};
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveContentCapturingMode', () => {
  const cases: Array<
    [ContentCapturingMode | undefined, string | undefined, string]
  > = [
    [ContentCapturingMode.NO_CONTENT, 'SPAN_AND_EVENT', ''],
    [ContentCapturingMode.EVENT_ONLY, undefined, 'EVENT_ONLY'],
    [ContentCapturingMode.SPAN_ONLY, 'EVENT_ONLY', 'SPAN_ONLY'],
    [ContentCapturingMode.SPAN_AND_EVENT, undefined, 'SPAN_AND_EVENT'],
    [undefined, 'EVENT_ONLY', 'EVENT_ONLY'],
    [undefined, 'SPAN_AND_EVENT', 'SPAN_AND_EVENT'],
    [undefined, 'NO_CONTENT', ''],
    [undefined, 'true', 'EVENT_ONLY'],
    [undefined, '1', 'EVENT_ONLY'],
    [undefined, 'bogus', ''],
    [undefined, undefined, ''],
  ];

  it.each(cases)(
    'field %s with env %s resolves to "%s"',
    (field, envValue, expected) => {
      setTelemetryEnv({
        [OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT]: envValue,
      });

      expect(contentCapturingModeValue(config(field))).toBe(expected);
    },
  );

  it.each(['yes', 'on', 'not_a_capture_mode', ' ', '0', 'false'])(
    'treats the unrecognised env value %s as NO_CONTENT',
    (envValue) => {
      setTelemetryEnv({
        [OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT]: envValue,
      });

      expect(resolveContentCapturingMode()).toBe(
        ContentCapturingMode.NO_CONTENT,
      );
      expect(contentCapturingModeValue()).toBe('');
    },
  );

  it.each(['true', 'TRUE', 'True', '1', ' true ', ' 1 '])(
    'coerces the legacy truthy env value %s to EVENT_ONLY',
    (envValue) => {
      setTelemetryEnv({
        [OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT]: envValue,
      });

      expect(resolveContentCapturingMode()).toBe(
        ContentCapturingMode.EVENT_ONLY,
      );
    },
  );

  it.each(['event_only', ' SPAN_AND_EVENT '])(
    'accepts the env value %s regardless of case and padding',
    (envValue) => {
      setTelemetryEnv({
        [OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT]: envValue,
      });

      expect(contentCapturingModeValue()).toBe(envValue.trim().toUpperCase());
    },
  );
});

describe('content routing', () => {
  const cases: Array<[ContentCapturingMode, boolean, boolean]> = [
    [ContentCapturingMode.NO_CONTENT, false, false],
    [ContentCapturingMode.EVENT_ONLY, true, false],
    [ContentCapturingMode.SPAN_ONLY, false, true],
    [ContentCapturingMode.SPAN_AND_EVENT, true, true],
  ];

  it.each(cases)('%s routes to logs=%s spans=%s', (mode, logs, spans) => {
    setTelemetryEnv();

    expect(shouldAddContentToLogs(config(mode))).toBe(logs);
    expect(shouldAddContentToExperimentalSpans(config(mode))).toBe(spans);
  });
});

describe('shouldAddContentToLegacySpans', () => {
  const cases: Array<
    [ContentCapturingMode | undefined, string | undefined, boolean]
  > = [
    [ContentCapturingMode.SPAN_ONLY, 'false', true],
    [ContentCapturingMode.SPAN_AND_EVENT, 'false', true],
    [ContentCapturingMode.EVENT_ONLY, 'true', false],
    [ContentCapturingMode.NO_CONTENT, 'true', false],
    [undefined, undefined, true],
    [undefined, 'true', true],
    [undefined, '1', true],
    [undefined, 'false', false],
    [undefined, '0', false],
  ];

  it.each(cases)(
    'field %s with env %s gives %s',
    (field, envValue, expected) => {
      setTelemetryEnv({[ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS]: envValue});

      expect(shouldAddContentToLegacySpans(config(field))).toBe(expected);
    },
  );

  it.each([undefined, 'true', '1', 'false', '0'])(
    'behaves identically with no config at all for env %s',
    (envValue) => {
      setTelemetryEnv({[ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS]: envValue});
      const withoutConfig = shouldAddContentToLegacySpans();

      expect(withoutConfig).toBe(shouldAddContentToLegacySpans(config()));
      expect(withoutConfig).toBe(envValue !== 'false' && envValue !== '0');
    },
  );
});

describe('admin lock', () => {
  const cases: Array<[string, boolean]> = [
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['True', true],
    [' 1 ', true],
    ['', false],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['yes', false],
  ];

  it.each(cases)('%s locks the per-request field: %s', (lockValue, locked) => {
    setTelemetryEnv({[ADK_TELEMETRY_IGNORE_RUN_CONFIG]: lockValue});
    const telemetry = config(ContentCapturingMode.EVENT_ONLY);

    expect(shouldAddContentToLogs(telemetry)).toBe(!locked);
    expect(Boolean(contentCapturingModeValue(telemetry))).toBe(!locked);
    expect(shouldAddContentToLegacySpans(telemetry)).toBe(locked);
  });

  it('beats the per-request field', () => {
    setTelemetryEnv({[ADK_TELEMETRY_IGNORE_RUN_CONFIG]: '1'});
    const telemetry = config(ContentCapturingMode.SPAN_AND_EVENT);

    expect(contentCapturingModeValue(telemetry)).toBe('');
    expect(shouldAddContentToLogs(telemetry)).toBe(false);
    expect(shouldAddContentToExperimentalSpans(telemetry)).toBe(false);
    expect(shouldAddContentToLegacySpans(telemetry)).toBe(true);
  });

  it('falls back to the operator env, not to "off"', () => {
    setTelemetryEnv({
      [ADK_TELEMETRY_IGNORE_RUN_CONFIG]: '1',
      [OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT]: 'EVENT_ONLY',
      [ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS]: 'false',
    });
    const telemetry = config(ContentCapturingMode.NO_CONTENT);

    expect(contentCapturingModeValue(telemetry)).toBe('EVENT_ONLY');
    expect(shouldAddContentToLogs(telemetry)).toBe(true);
    expect(shouldAddContentToExperimentalSpans(telemetry)).toBe(false);
    expect(shouldAddContentToLegacySpans(telemetry)).toBe(false);
  });
});

describe('shared config', () => {
  it('reads the environment on every call', () => {
    setTelemetryEnv();
    const telemetry = config();

    expect(contentCapturingModeValue(telemetry)).toBe('');

    vi.stubEnv(OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, 'SPAN_ONLY');

    expect(contentCapturingModeValue(telemetry)).toBe('SPAN_ONLY');
  });

  it('is never mutated by resolution', () => {
    setTelemetryEnv();
    const telemetry = config(ContentCapturingMode.SPAN_ONLY);
    const snapshot = structuredClone(telemetry);

    const first = [
      contentCapturingModeValue(telemetry),
      shouldAddContentToLogs(telemetry),
      shouldAddContentToExperimentalSpans(telemetry),
      shouldAddContentToLegacySpans(telemetry),
    ];

    setTelemetryEnv({[ADK_TELEMETRY_IGNORE_RUN_CONFIG]: '1'});
    const second = [
      contentCapturingModeValue(telemetry),
      shouldAddContentToLogs(telemetry),
      shouldAddContentToExperimentalSpans(telemetry),
      shouldAddContentToLegacySpans(telemetry),
    ];

    expect(telemetry).toEqual(snapshot);
    expect(first).toEqual(['SPAN_ONLY', false, true, true]);
    expect(second).toEqual(['', false, false, true]);
  });
});
