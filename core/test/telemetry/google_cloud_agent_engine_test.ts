/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Agent Engine branch of `getGcpExporters`.
 *
 * Kept apart from `google_cloud_test.ts`, which pins the behaviour off Agent
 * Engine and must stay untouched.
 */

import {
  clearAgentEngineMetricsSetupCache,
  getGcpExporters,
  RequestDrivenMetricReader,
} from '@google/adk';
import {metrics} from '@opentelemetry/api';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {
  PeriodicExportingMetricReader,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {afterEach, describe, expect, it, vi} from 'vitest';

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const PROJECT_ID = 'test-project';

class StubExporter implements PushMetricExporter {
  export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    resultCallback({code: ExportResultCode.SUCCESS});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getProjectId(): Promise<string> {
      return Promise.resolve(PROJECT_ID);
    }
  },
}));

vi.mock('../../src/telemetry/gcp_metric_exporter.js', () => ({
  createGcpMetricExporter: () => Promise.resolve(new StubExporter()),
}));

afterEach(() => {
  clearAgentEngineMetricsSetupCache();
  metrics.disable();
  vi.unstubAllEnvs();
});

describe('getGcpExporters on Agent Engine', () => {
  it('exports metrics through the request-driven reader', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const hooks = await getGcpExporters({enableMetrics: true});

    expect(hooks.metricReaders?.[0]).toBeInstanceOf(RequestDrivenMetricReader);
  });

  it('adds the span processor that drives the reader', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const hooks = await getGcpExporters({
      enableTracing: true,
      enableMetrics: true,
    });

    // The Cloud Trace processor keeps its place; the driver is appended.
    expect(hooks.spanProcessors).toHaveLength(2);
  });

  it('keeps the periodic reader off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

    const hooks = await getGcpExporters({enableMetrics: true});

    expect(hooks.metricReaders?.[0]).toBeInstanceOf(
      PeriodicExportingMetricReader,
    );
    expect(hooks.spanProcessors).toEqual([]);
  });

  it('builds no reader when metrics are disabled', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const hooks = await getGcpExporters({enableTracing: true});

    expect(hooks.metricReaders).toEqual([]);
    expect(hooks.spanProcessors).toHaveLength(1);
  });
});
