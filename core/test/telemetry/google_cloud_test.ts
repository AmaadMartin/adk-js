/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpProjectId,
  getGcpResource,
  OtelExportersConfig,
} from '@google/adk';
import {CallCredentials, credentials, Metadata} from '@grpc/grpc-js';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-grpc';
import {detectResources, Resource} from '@opentelemetry/resources';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {GoogleAuth, OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

vi.hoisted(() => {
  vi.resetModules();
});
// Mock Google Cloud modules
vi.mock('google-auth-library');
vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter');
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc');
vi.mock('@opentelemetry/sdk-trace-base');
vi.mock('@opentelemetry/sdk-metrics');
vi.mock('@opentelemetry/sdk-logs');
vi.mock('@opentelemetry/resources');
vi.mock('@opentelemetry/resource-detector-gcp');
vi.mock('../../src/utils/logger.js');

describe('getGcpExporters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test initializing correct providers in getGcpExporters
   * when enabling telemetry via Google Cloud.
   *
   * This test is parameterized to test different combinations of GCP service options.
   */
  const testCases: Array<{
    config: OtelExportersConfig;
    expectedSpanProcessors: number;
    expectedMetricReaders: number;
    expectedLogRecordProcessors: number;
    description: string;
  }> = [
    {
      config: {
        enableTracing: true,
        enableMetrics: false,
        enableLogging: false,
      },
      expectedSpanProcessors: 1,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 0,
      description: 'should set up Cloud Trace when enableTracing is true',
    },
    {
      config: {
        enableTracing: false,
        enableMetrics: true,
        enableLogging: false,
      },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 1,
      expectedLogRecordProcessors: 0,
      description: 'should set up Cloud Monitoring when enableMetrics is true',
    },
    {
      config: {
        enableTracing: false,
        enableMetrics: false,
        enableLogging: true,
      },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 0, // Cloud Logging is not supported in Node.js
      description: 'should not set up Cloud Logging (unsupported in Node.js)',
    },
    {
      config: {
        enableTracing: true,
        enableMetrics: true,
        enableLogging: false,
      },
      expectedSpanProcessors: 1,
      expectedMetricReaders: 1,
      expectedLogRecordProcessors: 0,
      description:
        'should set up multiple exporters when multiple options are enabled',
    },
  ];

  testCases.forEach(
    ({
      config,
      expectedSpanProcessors,
      expectedMetricReaders,
      expectedLogRecordProcessors,
      description,
    }) => {
      it(description, async () => {
        const mockAuth = {
          getProjectId: vi.fn().mockResolvedValue('test-project'),
          getClient: vi.fn().mockResolvedValue(new OAuth2Client()),
        };
        vi.mocked(GoogleAuth).mockImplementation(
          () => mockAuth as unknown as GoogleAuth,
        );

        const result = await getGcpExporters(config);

        expect(result.spanProcessors?.length).toBe(expectedSpanProcessors);
        expect(result.metricReaders?.length).toBe(expectedMetricReaders);
        expect(result.logRecordProcessors?.length).toBe(
          expectedLogRecordProcessors,
        );
      });
    },
  );

  it('should return empty hooks when GoogleAuth fails to get project ID', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockRejectedValue(new Error('Auth error')),
    };
    vi.mocked(GoogleAuth).mockImplementation(
      () => mockAuth as unknown as GoogleAuth,
    );

    const result = await getGcpExporters({enableTracing: true});

    expect(result).toEqual({});
  });

  it('should return empty hooks when project ID is null', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockResolvedValue(null),
    };
    vi.mocked(GoogleAuth).mockImplementation(
      () => mockAuth as unknown as GoogleAuth,
    );

    const result = await getGcpExporters({enableTracing: true});

    expect(result).toEqual({});
  });
});

const TELEMETRY_SERVICE_URL = 'https://telemetry.googleapis.com';

const EXPORT_CALL_OPTIONS = {
  method_name: 'Export',
  service_url: TELEMETRY_SERVICE_URL,
};

/**
 * Builds the metric exporter and returns the per-call credentials gRPC would
 * attach to every export RPC.
 */
async function getExportCallCredentials(): Promise<CallCredentials> {
  const combineSpy = vi.spyOn(credentials, 'combineChannelCredentials');

  await getGcpExporters({enableMetrics: true});

  expect(combineSpy).toHaveBeenCalledTimes(1);
  const [, callCredentials] = combineSpy.mock.calls[0];
  return callCredentials;
}

describe('getGcpExporters OTLP metric export', () => {
  let authClient: OAuth2Client;

  beforeEach(() => {
    vi.clearAllMocks();
    // The suite above swaps in its own GoogleAuth constructor implementation,
    // which outlives clearAllMocks; reset it so `new GoogleAuth()` returns the
    // automocked instance these tests configure through the prototype.
    vi.mocked(GoogleAuth).mockReset();
    authClient = new OAuth2Client();
    vi.mocked(GoogleAuth.prototype.getProjectId).mockImplementation(() =>
      Promise.resolve('test-project'),
    );
    vi.mocked(GoogleAuth.prototype.getClient).mockResolvedValue(authClient);
    vi.mocked(authClient.getRequestHeaders).mockResolvedValue(new Headers());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports metrics to the Cloud Telemetry OTLP endpoint', async () => {
    await getGcpExporters({enableMetrics: true});

    expect(OTLPMetricExporter).toHaveBeenCalledTimes(1);
    const [exporterConfig] = vi.mocked(OTLPMetricExporter).mock.calls[0];
    expect(exporterConfig?.url).toBe(TELEMETRY_SERVICE_URL);
    expect(exporterConfig?.credentials).toBeDefined();
  });

  it('wraps the OTLP exporter in a 5s periodic reader', async () => {
    await getGcpExporters({enableMetrics: true});

    expect(PeriodicExportingMetricReader).toHaveBeenCalledTimes(1);
    const [readerConfig] = vi.mocked(PeriodicExportingMetricReader).mock
      .calls[0];
    expect(readerConfig.exportIntervalMillis).toBe(5000);
    expect(readerConfig.exporter).toBe(
      vi.mocked(OTLPMetricExporter).mock.instances[0],
    );
  });

  it('constructs no metric exporter when metrics are not enabled', async () => {
    const hooks = await getGcpExporters();

    expect(hooks.metricReaders).toEqual([]);
    expect(OTLPMetricExporter).not.toHaveBeenCalled();
    expect(PeriodicExportingMetricReader).not.toHaveBeenCalled();
  });

  it('mints gRPC metadata from ADC request headers', async () => {
    vi.mocked(authClient.getRequestHeaders).mockResolvedValue(
      new Headers({
        authorization: 'Bearer test-token',
        'x-goog-user-project': 'test-project',
      }),
    );

    const callCredentials = await getExportCallCredentials();
    const metadata: Metadata =
      await callCredentials.generateMetadata(EXPORT_CALL_OPTIONS);

    expect(authClient.getRequestHeaders).toHaveBeenCalledWith(
      TELEMETRY_SERVICE_URL,
    );
    expect(metadata.get('authorization')).toEqual(['Bearer test-token']);
    expect(metadata.get('x-goog-user-project')).toEqual(['test-project']);
  });

  it('forwards a credential Error to the export RPC', async () => {
    const failure = new Error('token refresh failed');
    vi.mocked(authClient.getRequestHeaders).mockRejectedValue(failure);

    const callCredentials = await getExportCallCredentials();
    const rejection = await callCredentials
      .generateMetadata(EXPORT_CALL_OPTIONS)
      .catch((e: unknown) => e);

    expect(rejection).toBe(failure);
  });

  it('wraps a non-Error credential rejection before forwarding it', async () => {
    vi.mocked(authClient.getRequestHeaders).mockRejectedValue('boom');

    const callCredentials = await getExportCallCredentials();
    const rejection = await callCredentials
      .generateMetadata(EXPORT_CALL_OPTIONS)
      .catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toHaveProperty('message', 'boom');
  });

  it('disables metrics but keeps tracing when the auth client is unavailable', async () => {
    vi.mocked(GoogleAuth.prototype.getClient).mockRejectedValue(
      new Error('no ADC'),
    );

    const hooks = await getGcpExporters({
      enableTracing: true,
      enableMetrics: true,
    });

    expect(hooks.spanProcessors?.length).toBe(1);
    expect(hooks.metricReaders).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Application Default Credentials'),
    );
  });

  it('constructs the exporter without performing network I/O', async () => {
    await getGcpExporters({enableMetrics: true});

    expect(OTLPMetricExporter).toHaveBeenCalledTimes(1);
    expect(authClient.getRequestHeaders).not.toHaveBeenCalled();
  });
});

describe('getGcpResource', () => {
  it('should detect GCP resources using gcpDetector', async () => {
    const mockDetectedResource = {attributes: {'cloud.provider': 'gcp'}};
    vi.mocked(detectResources).mockResolvedValue(
      mockDetectedResource as unknown as Resource,
    );

    const result = await getGcpResource();

    expect(detectResources).toHaveBeenCalledWith({
      detectors: [expect.any(Object), expect.any(Object), expect.any(Object)],
    });
    expect(result).toEqual(mockDetectedResource);
  });
});

describe('getGcpProjectId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(GoogleAuth).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the project from Application Default Credentials', async () => {
    vi.mocked(GoogleAuth.prototype.getProjectId).mockImplementation(() =>
      Promise.resolve('adc-project'),
    );

    await expect(getGcpProjectId()).resolves.toBe('adc-project');
  });

  it('resolves undefined when the project cannot be determined', async () => {
    vi.mocked(GoogleAuth.prototype.getProjectId).mockImplementation(() =>
      Promise.reject(new Error('no ADC')),
    );

    await expect(getGcpProjectId()).resolves.toBeUndefined();
  });
});
