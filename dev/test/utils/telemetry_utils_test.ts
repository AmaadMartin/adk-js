/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpResource,
  maybeSetOtelProviders,
  OTelHooks,
} from '@google/adk';
import {emptyResource} from '@opentelemetry/resources';
import {SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    getGcpExporters: vi.fn(),
    getGcpResource: vi.fn(),
    maybeSetOtelProviders: vi.fn(),
  };
});

const OTEL_ENDPOINT_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

const ENDPOINT = 'http://localhost:4318';

const spanProcessor: SpanProcessor = {
  forceFlush: async () => {},
  onStart: () => {},
  onEnd: () => {},
  shutdown: async () => {},
};

describe('setupTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every case below distinguishes the env branch from the default branch, so
    // none of the four endpoint variables may leak in from the environment.
    for (const name of OTEL_ENDPOINT_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
  });

  it('should wrap the internal exporters in a hook when no OTEL endpoint is set', async () => {
    await setupTelemetry();

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([{spanProcessors: []}]);
  });

  it.each(OTEL_ENDPOINT_ENV_VARS)(
    'should add no hooks of its own when %s is set',
    async (name) => {
      vi.stubEnv(name, ENDPOINT);

      await setupTelemetry(false, []);

      // The env branch only contributes a hook when there are internal
      // exporters to wrap; an empty array is what distinguishes it from the
      // default branch.
      expect(maybeSetOtelProviders).toHaveBeenCalledWith([]);
    },
  );

  it('should still wrap internal exporters on the env branch', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', ENDPOINT);

    await setupTelemetry(false, [spanProcessor]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([
      {spanProcessors: [spanProcessor]},
    ]);
  });

  it('should treat an empty endpoint variable as unset', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');

    await setupTelemetry(false, []);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([{spanProcessors: []}]);
  });

  it('should prefer the GCP branch over the env branch', async () => {
    const gcpHooks: OTelHooks = {spanProcessors: []};
    const resource = emptyResource();
    vi.mocked(getGcpExporters).mockResolvedValue(gcpHooks);
    vi.mocked(getGcpResource).mockReturnValue(resource);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', ENDPOINT);

    await setupTelemetry(true, []);

    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableLogging: false,
      enableMetrics: true,
    });
    expect(maybeSetOtelProviders).toHaveBeenCalledWith([gcpHooks], resource);
  });

  it('should put the internal exporters ahead of the GCP hooks', async () => {
    const gcpHooks: OTelHooks = {spanProcessors: []};
    const resource = emptyResource();
    vi.mocked(getGcpExporters).mockResolvedValue(gcpHooks);
    vi.mocked(getGcpResource).mockReturnValue(resource);

    await setupTelemetry(true, [spanProcessor]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      [{spanProcessors: [spanProcessor]}, gcpHooks],
      resource,
    );
  });
});
