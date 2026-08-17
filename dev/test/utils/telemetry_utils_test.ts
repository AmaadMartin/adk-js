/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_ENGINE_ID_ENV_VAR, getPropagatedContext} from '@google/adk';
import {context, propagation, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

const SUPPORT_ID_ATTRIBUTE = 'supportID';
const SUPPORT_ID_VALUE = 'support-id-value';

/**
 * Endpoint variables that would send `setupTelemetry` down its OTLP branch.
 * They are cleared so the test always exercises the same branch.
 */
const OTLP_ENDPOINT_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

describe('setupTelemetry top span processor', () => {
  const exporter = new InMemorySpanExporter();

  beforeEach(() => {
    for (const name of OTLP_ENDPOINT_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
    exporter.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Release the globals `maybeSetOtelProviders` registered, so the next test
    // installs its own providers.
    trace.disable();
    context.disable();
    propagation.disable();
  });

  /** Sets telemetry up, then records one root span carrying a support id. */
  async function recordTopSpan(): Promise<ReadableSpan> {
    await setupTelemetry(false, [new SimpleSpanProcessor(exporter)]);

    const ctx = getPropagatedContext({traceparent: SUPPORT_ID_VALUE});
    trace
      .getTracer('telemetry_utils_test')
      .startSpan('invocation', undefined, ctx)
      .end();

    const span = exporter.getFinishedSpans().at(0);
    if (!span) {
      expect.fail('setupTelemetry did not install the exporter');
    }
    return span;
  }

  it('records the support id on the top span on Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const span = await recordTopSpan();

    expect(span.attributes[SUPPORT_ID_ATTRIBUTE]).toBe(SUPPORT_ID_VALUE);
  });

  it('installs no top span processor off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

    const span = await recordTopSpan();

    expect(span.attributes).not.toHaveProperty(SUPPORT_ID_ATTRIBUTE);
  });
});
