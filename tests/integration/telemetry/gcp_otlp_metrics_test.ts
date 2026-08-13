/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getGcpExporters, getGcpResource} from '@google/adk';
import {Attributes} from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {GoogleAuth, OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Application Default Credentials are the only ambient input stubbed here: the
// OTLP gRPC exporter and the metric reader are the real packages, so this test
// proves they compose.
vi.mock('google-auth-library');

describe('GCP OTLP metric export', () => {
  let authClient: OAuth2Client;

  beforeEach(() => {
    vi.clearAllMocks();
    authClient = new OAuth2Client();
    vi.mocked(GoogleAuth.prototype.getProjectId).mockImplementation(() =>
      Promise.resolve('test-project'),
    );
    vi.mocked(GoogleAuth.prototype.getClient).mockResolvedValue(authClient);
    vi.mocked(authClient.getRequestHeaders).mockResolvedValue(
      new Headers({authorization: 'Bearer test-token'}),
    );
  });

  it('installs a periodic reader over the real OTLP exporter', async () => {
    const hooks = await getGcpExporters({
      enableTracing: false,
      enableMetrics: true,
    });

    expect(hooks.spanProcessors).toEqual([]);
    expect(hooks.metricReaders).toHaveLength(1);
    const reader = hooks.metricReaders?.[0];
    expect(reader).toBeInstanceOf(PeriodicExportingMetricReader);

    try {
      // Nothing may be exported before a MeterProvider drains the reader, so no
      // credential is minted and no gRPC channel is opened.
      expect(authClient.getRequestHeaders).not.toHaveBeenCalled();
    } finally {
      // Releases the 5s export timer so it cannot outlive this test.
      await reader?.shutdown();
    }
  });
});

/** Keeps the probe reader's timer from firing during the test. */
const EXPORT_INTERVAL_LONGER_THAN_TEST_MS = 600000;

/**
 * Collects the resource attributes a metric exporter would receive, by driving
 * a real MeterProvider built the way `maybeSetOtelProviders` builds one.
 */
async function collectExportedResourceAttributes(
  resource: ReturnType<typeof getGcpResource>,
): Promise<Attributes> {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: EXPORT_INTERVAL_LONGER_THAN_TEST_MS,
  });
  const provider = new MeterProvider({resource, readers: [reader]});
  try {
    provider.getMeter('adk-test').createCounter('probe').add(1);
    const {resourceMetrics} = await reader.collect();
    await resourceMetrics.resource.waitForAsyncAttributes?.();
    return resourceMetrics.resource.attributes;
  } finally {
    await provider.shutdown();
  }
}

describe('GCP OTLP resource', () => {
  beforeEach(() => {
    // The GCP detector reaches for the metadata server. Disabling detection
    // pins these tests to the off-Google-Cloud path -- the `adk web
    // --otel_to_cloud` laptop workflow -- and keeps them off the network.
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('carries the project id the Telemetry API routes on', async () => {
    const attributes = await collectExportedResourceAttributes(
      getGcpResource('test-project'),
    );

    expect(attributes['gcp.project_id']).toBe('test-project');
  });

  it('omits the project id when none is resolved', async () => {
    const attributes =
      await collectExportedResourceAttributes(getGcpResource());

    expect(attributes['gcp.project_id']).toBeUndefined();
  });

  it('supplies the instance label Prometheus ingestion requires', async () => {
    const attributes = await collectExportedResourceAttributes(
      getGcpResource('test-project'),
    );

    expect(attributes['service.instance.id']).toEqual(expect.any(String));
  });

  it('lets OTEL_RESOURCE_ATTRIBUTES supply the location label', async () => {
    vi.stubEnv(
      'OTEL_RESOURCE_ATTRIBUTES',
      'location=us-central1,service.name=adk-agent',
    );

    const attributes = await collectExportedResourceAttributes(
      getGcpResource('test-project'),
    );

    expect(attributes['location']).toBe('us-central1');
    expect(attributes['service.name']).toBe('adk-agent');
    expect(attributes['gcp.project_id']).toBe('test-project');
  });

  it('lets OTEL_RESOURCE_ATTRIBUTES override the resolved project id', async () => {
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'gcp.project_id=override-project');

    const attributes = await collectExportedResourceAttributes(
      getGcpResource('test-project'),
    );

    expect(attributes['gcp.project_id']).toBe('override-project');
  });
});
