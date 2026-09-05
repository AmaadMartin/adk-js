/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getPropagatedContext} from '@google/adk';
import {context, propagation, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

// The Cloud exporters need GCP credentials and a metadata server. The branch
// under test is which span processors reach `maybeSetOtelProviders`, so only
// those two functions are replaced.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  const {resourceFromAttributes} = await import('@opentelemetry/resources');
  return {
    ...actual,
    getGcpExporters: () => Promise.resolve({}),
    getGcpResource: () => resourceFromAttributes({}),
  };
});

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const OTLP_TRACES_ENDPOINT_ENV_VAR = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
const SUPPORT_ID_ATTRIBUTE = 'supportID';
const SUPPORT_ID_VALUE = 'support-id-value';

/**
 * Endpoint variables that would send `setupTelemetry` down its OTLP branch.
 * They are cleared so each case exercises the branch it names.
 */
const OTLP_ENDPOINT_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  OTLP_TRACES_ENDPOINT_ENV_VAR,
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

/** The three branches of `setupTelemetry`, by how they are selected. */
const BRANCHES = [
  {name: 'the default branch', otelToCloud: false, otlpEndpoint: false},
  {name: 'the Google Cloud branch', otelToCloud: true, otlpEndpoint: false},
  {name: 'the OTLP environment branch', otelToCloud: false, otlpEndpoint: true},
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
  async function recordTopSpan(
    otelToCloud: boolean,
    otlpEndpoint: boolean,
  ): Promise<ReadableSpan> {
    if (otlpEndpoint) {
      vi.stubEnv(OTLP_TRACES_ENDPOINT_ENV_VAR, 'http://127.0.0.1:1/v1/traces');
    }
    await setupTelemetry(otelToCloud, [new SimpleSpanProcessor(exporter)]);

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

  it.each(BRANCHES)(
    'records the support id on the top span on Agent Engine, in $name',
    async ({otelToCloud, otlpEndpoint}) => {
      vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

      const span = await recordTopSpan(otelToCloud, otlpEndpoint);

      expect(span.attributes[SUPPORT_ID_ATTRIBUTE]).toBe(SUPPORT_ID_VALUE);
    },
  );

  it.each(BRANCHES)(
    'installs no top span processor off Agent Engine, in $name',
    async ({otelToCloud, otlpEndpoint}) => {
      vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

      const span = await recordTopSpan(otelToCloud, otlpEndpoint);

      expect(span.attributes).not.toHaveProperty(SUPPORT_ID_ATTRIBUTE);
    },
  );
});
