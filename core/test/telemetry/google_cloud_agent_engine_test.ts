/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getProjectId(): Promise<string> {
      return Promise.resolve('test-project');
    }
  },
}));
vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter');
vi.mock('@google-cloud/opentelemetry-cloud-monitoring-exporter');

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

/**
 * Imports a fresh copy of both modules, so the memoized Agent Engine gate is
 * evaluated again under the current environment.
 */
async function freshModules() {
  vi.resetModules();
  return {
    googleCloud: await import('../../src/telemetry/google_cloud.js'),
    metrics: await import('../../src/telemetry/agent_engine_metrics.js'),
  };
}

describe('getGcpExporters on Agent Engine', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('installs the request-driven reader and its span processor', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, 'engine-id');
    const {googleCloud, metrics} = await freshModules();

    const result = await googleCloud.getGcpExporters({enableMetrics: true});

    expect(result.metricReaders?.length).toBe(1);
    expect(result.metricReaders?.[0]).toBeInstanceOf(
      metrics.RequestDrivenMetricReader,
    );
    // The processor drives the reader, so it is installed under metrics even
    // with tracing off.
    expect(result.spanProcessors?.length).toBe(1);
    expect(result.spanProcessors?.[0]).toBeInstanceOf(
      metrics.MetricsFlushingSpanProcessor,
    );
    expect(metrics.getRequestDrivenMetricsState()?.reader).toBe(
      result.metricReaders?.[0],
    );
  });

  it('keeps the periodic reader off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);
    const {googleCloud, metrics} = await freshModules();

    const result = await googleCloud.getGcpExporters({
      enableTracing: true,
      enableMetrics: true,
    });

    expect(result.metricReaders?.length).toBe(1);
    expect(result.metricReaders?.[0]).toBeInstanceOf(
      PeriodicExportingMetricReader,
    );
    expect(result.spanProcessors?.length).toBe(1);
    expect(result.spanProcessors?.[0]).not.toBeInstanceOf(
      metrics.MetricsFlushingSpanProcessor,
    );
    expect(metrics.getRequestDrivenMetricsState()).toBeUndefined();
  });

  it('adds no metric reader when metrics are disabled', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, 'engine-id');
    const {googleCloud, metrics} = await freshModules();

    const result = await googleCloud.getGcpExporters({enableTracing: true});

    expect(result.metricReaders).toEqual([]);
    expect(result.spanProcessors?.length).toBe(1);
    expect(metrics.getRequestDrivenMetricsState()).toBeUndefined();
  });
});
