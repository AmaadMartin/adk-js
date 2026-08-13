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
  TelemetryConfig,
  shouldAddContentToLegacySpans,
} from '../../src/telemetry/context.js';

const TELEMETRY_ENV_VARS = [
  ADK_TELEMETRY_IGNORE_RUN_CONFIG,
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
    setTelemetryEnv({
      [ADK_TELEMETRY_IGNORE_RUN_CONFIG]: lockValue,
      [ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS]: 'false',
    });

    // Locked, the operator's 'false' wins; unlocked, the span-bearing field
    // wins.
    expect(
      shouldAddContentToLegacySpans(config(ContentCapturingMode.SPAN_ONLY)),
    ).toBe(!locked);
  });

  it('beats a per-request field that would enable capture', () => {
    setTelemetryEnv({
      [ADK_TELEMETRY_IGNORE_RUN_CONFIG]: '1',
      [ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS]: 'false',
    });

    expect(
      shouldAddContentToLegacySpans(
        config(ContentCapturingMode.SPAN_AND_EVENT),
      ),
    ).toBe(false);
  });

  it('falls back to the operator env, not to "off"', () => {
    setTelemetryEnv({[ADK_TELEMETRY_IGNORE_RUN_CONFIG]: '1'});

    expect(
      shouldAddContentToLegacySpans(config(ContentCapturingMode.NO_CONTENT)),
    ).toBe(true);
  });
});

describe('shared config', () => {
  it('reads the environment on every call', () => {
    setTelemetryEnv();
    const telemetry = config();

    expect(shouldAddContentToLegacySpans(telemetry)).toBe(true);

    vi.stubEnv(ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS, 'false');

    expect(shouldAddContentToLegacySpans(telemetry)).toBe(false);
  });

  it('is never mutated by resolution', () => {
    setTelemetryEnv();
    const telemetry = config(ContentCapturingMode.NO_CONTENT);
    const snapshot = structuredClone(telemetry);

    const unlocked = shouldAddContentToLegacySpans(telemetry);
    setTelemetryEnv({[ADK_TELEMETRY_IGNORE_RUN_CONFIG]: '1'});
    const locked = shouldAddContentToLegacySpans(telemetry);

    expect(telemetry).toEqual(snapshot);
    expect(unlocked).toBe(false);
    expect(locked).toBe(true);
  });
});
