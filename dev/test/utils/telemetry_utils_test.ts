/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpResource,
  getPropagatedContext,
  maybeSetOtelProviders,
  ResolvedGoogleAuth,
  resolveGoogleAuth,
} from '@google/adk';
import {context, propagation, trace} from '@opentelemetry/api';
import {emptyResource} from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
// `@google/adk` declares google-auth-library as a direct dependency, so this
// test-only import needs no dependency of its own.
import {OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

// The Cloud exporters need GCP credentials and a metadata server, so they are
// replaced. `maybeSetOtelProviders` starts as a spy that installs nothing. The
// top span cases restore the real one, because they read the spans back.
vi.mock('@google/adk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/adk')>()),
  resolveGoogleAuth: vi.fn(),
  getGcpExporters: vi.fn(() => Promise.resolve({})),
  getGcpResource: vi.fn(() => emptyResource()),
  maybeSetOtelProviders: vi.fn(),
}));

const RESOLVED: ResolvedGoogleAuth = {
  authClient: new OAuth2Client(),
  projectId: 'dev-project',
};

describe('setupTelemetry with --otel_to_cloud', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('should resolve the credentials once and pass them to both calls', async () => {
    vi.mocked(resolveGoogleAuth).mockResolvedValue(RESOLVED);

    await setupTelemetry(true);

    expect(resolveGoogleAuth).toHaveBeenCalledTimes(1);
    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableMetrics: true,
      enableLogging: true,
      googleAuth: RESOLVED,
    });
    // The same project must reach the resource, or the log records and the
    // spans describe different projects on Agent Engine.
    expect(getGcpResource).toHaveBeenCalledWith(RESOLVED.projectId);
  });

  it('should install the internal span processors alongside the GCP ones', async () => {
    vi.mocked(resolveGoogleAuth).mockResolvedValue(RESOLVED);
    const internal = new BatchSpanProcessor(new InMemorySpanExporter());

    await setupTelemetry(true, [internal]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      [{spanProcessors: [internal]}, {}],
      expect.anything(),
    );
    await internal.shutdown();
  });

  it('should degrade instead of throwing when the credentials are missing', async () => {
    vi.mocked(resolveGoogleAuth).mockResolvedValue(undefined);

    await expect(setupTelemetry(true)).resolves.toBeUndefined();

    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableMetrics: true,
      enableLogging: true,
      googleAuth: undefined,
    });
    expect(getGcpResource).toHaveBeenCalledWith(undefined);
  });
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

  beforeEach(async () => {
    // These cases read the recorded spans back, so the real function must
    // install the providers.
    const actual =
      await vi.importActual<typeof import('@google/adk')>('@google/adk');
    vi.mocked(maybeSetOtelProviders).mockImplementation(
      actual.maybeSetOtelProviders,
    );
    vi.mocked(getGcpExporters).mockResolvedValue({});
    vi.mocked(getGcpResource).mockReturnValue(emptyResource());
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
