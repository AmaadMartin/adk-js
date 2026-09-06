/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which metric reader `getGcpExporters` installs, on and off Agent Engine.
 *
 * The existing suite in `google_cloud_test.ts` counts the hooks with the whole
 * OpenTelemetry SDK mocked. This one keeps the real SDK, so it can tell the two
 * readers apart, and mocks only the credentials lookup and the optional Cloud
 * Monitoring exporter.
 */

import {OTelHooks, getGcpExporters} from '@google/adk';
import {MeterProvider} from '@opentelemetry/sdk-metrics';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('google-auth-library');
vi.mock('@google-cloud/opentelemetry-cloud-monitoring-exporter', async () => {
  const {ExportResultCode} = await import('@opentelemetry/core');
  return {
    MetricExporter: class {
      export(
        _metrics: unknown,
        resultCallback: (result: {code: number}) => void,
      ): void {
        resultCallback({code: ExportResultCode.SUCCESS});
      }
      forceFlush(): Promise<void> {
        return Promise.resolve();
      }
      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

const AGENT_ENGINE_ID_ENV = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

/** True when the reader exposes the request-lifecycle hooks. */
function isRequestDriven(reader: object): boolean {
  return 'noteRequestStart' in reader && 'noteRequestEnd' in reader;
}

/** Binds the returned readers to a provider and shuts them down, as a host would. */
function dispose(hooks: OTelHooks): Promise<void> {
  return new MeterProvider({readers: hooks.metricReaders ?? []}).shutdown();
}

describe('getGcpExporters metric reader selection', () => {
  beforeEach(() => {
    vi.mocked(GoogleAuth).mockImplementation(
      () =>
        ({
          getProjectId: vi.fn().mockResolvedValue('test-project'),
        }) as unknown as GoogleAuth,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('installs a periodic reader and no span processor off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV, undefined);

    const hooks = await getGcpExporters({enableMetrics: true});

    expect(hooks.metricReaders).toHaveLength(1);
    expect(isRequestDriven(hooks.metricReaders![0])).toBe(false);
    expect(hooks.spanProcessors).toEqual([]);
    await dispose(hooks);
  });

  it('installs the request-driven reader and its span processor on Agent Engine', async () => {
    vi.stubEnv(
      AGENT_ENGINE_ID_ENV,
      'projects/p/locations/l/reasoningEngines/1',
    );

    const hooks = await getGcpExporters({enableMetrics: true});

    expect(hooks.metricReaders).toHaveLength(1);
    expect(isRequestDriven(hooks.metricReaders![0])).toBe(true);
    expect(hooks.spanProcessors).toHaveLength(1);
    await dispose(hooks);
  });

  it('keeps the Cloud Trace processor alongside the metrics one', async () => {
    vi.stubEnv(
      AGENT_ENGINE_ID_ENV,
      'projects/p/locations/l/reasoningEngines/1',
    );

    const hooks = await getGcpExporters({
      enableTracing: true,
      enableMetrics: true,
    });

    expect(hooks.spanProcessors).toHaveLength(2);
    await dispose(hooks);
  });

  it('installs nothing for metrics when metrics are disabled', async () => {
    vi.stubEnv(
      AGENT_ENGINE_ID_ENV,
      'projects/p/locations/l/reasoningEngines/1',
    );

    const hooks = await getGcpExporters({enableMetrics: false});

    expect(hooks.metricReaders).toEqual([]);
    expect(hooks.spanProcessors).toEqual([]);
  });
});
