/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  GcpExportersConfig,
  getGcpExporters,
  getGcpResource,
  OTelHooks,
} from '@google/adk';
import {AttributeValue} from '@opentelemetry/api';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {LoggerProvider, ReadableLogRecord} from '@opentelemetry/sdk-logs';
import {GoogleAuth} from 'google-auth-library';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';

import {logger} from '../../src/utils/logger.js';

import {
  emitLogRecord,
  FakeAuthClient,
  gaxiosResponse,
} from './telemetry_fixtures.js';

vi.hoisted(() => {
  vi.resetModules();
});
vi.mock('@opentelemetry/exporter-trace-otlp-http');
vi.mock('@opentelemetry/exporter-metrics-otlp-http');
vi.mock('@opentelemetry/exporter-logs-otlp-http');
vi.mock('@opentelemetry/sdk-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opentelemetry/sdk-metrics')>()),
  PeriodicExportingMetricReader: vi.fn(),
}));
// The real detector reaches for the GCE metadata server.
vi.mock('@opentelemetry/resource-detector-gcp', () => ({
  gcpDetector: {
    detect: () => ({attributes: {'cloud.platform': 'gcp_kubernetes_engine'}}),
  },
}));

const PROJECT_ID = 'test-project';
const PROJECT_NUMBER = '1234567890';

/**
 * `ExportResultCode.SUCCESS`. The enum lives in `@opentelemetry/core`, which
 * this package does not depend on directly.
 */
const EXPORT_SUCCESS = 0;

/** Every variable these tests read, cleared before each of them. */
const MANAGED_ENV = [
  'GCLOUD_PROJECT',
  'GCP_DEFAULT_LOG_NAME',
  'GOOGLE_API_USE_CLIENT_CERTIFICATE',
  'GOOGLE_API_USE_MTLS_ENDPOINT',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'OTEL_RESOURCE_ATTRIBUTES',
];

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    vi.stubEnv(name, undefined);
  }
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Releases the batch processors' timers and exporters. */
async function shutdown(hooks: OTelHooks): Promise<void> {
  for (const processor of hooks.spanProcessors ?? []) {
    await processor.shutdown();
  }
  for (const processor of hooks.logRecordProcessors ?? []) {
    await processor.shutdown();
  }
}

describe('getGcpExporters', () => {
  /**
   * Test initializing correct providers in getGcpExporters
   * when enabling telemetry via Google Cloud.
   *
   * This test is parameterized to test different combinations of GCP service options.
   */
  const testCases: Array<{
    config: GcpExportersConfig;
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
      expectedLogRecordProcessors: 1,
      description: 'should set up Cloud Logging when enableLogging is true',
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
        const result = await getGcpExporters({
          ...config,
          googleAuth: {
            authClient: new FakeAuthClient(),
            projectId: PROJECT_ID,
          },
        });

        expect(result.spanProcessors?.length).toBe(expectedSpanProcessors);
        expect(result.metricReaders?.length).toBe(expectedMetricReaders);
        expect(result.logRecordProcessors?.length).toBe(
          expectedLogRecordProcessors,
        );
        await shutdown(result);
      });
    },
  );

  it('should return empty hooks when GoogleAuth fails to get project ID', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue(
      new FakeAuthClient(),
    );
    vi.spyOn(GoogleAuth.prototype, 'getProjectId').mockImplementation(() => {
      throw new Error('Auth error');
    });

    const result = await getGcpExporters({enableTracing: true});

    expect(result).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot determine GCP Project'),
    );
  });

  it('should return empty hooks when project ID is null', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue(
      new FakeAuthClient(),
    );
    // `getProjectId` is overloaded and its callback form is the signature the
    // spy takes, so this stands in for a lookup that produced nothing.
    vi.spyOn(GoogleAuth.prototype, 'getProjectId').mockImplementation(
      () => undefined,
    );

    const result = await getGcpExporters({enableTracing: true});

    expect(result).toEqual({});
  });

  it('should not resolve default credentials when googleAuth is supplied', async () => {
    const getClient = vi.spyOn(GoogleAuth.prototype, 'getClient');
    const getProjectId = vi.spyOn(GoogleAuth.prototype, 'getProjectId');

    const result = await getGcpExporters({
      enableTracing: true,
      googleAuth: {authClient: new FakeAuthClient(), projectId: PROJECT_ID},
    });

    expect(getClient).not.toHaveBeenCalled();
    expect(getProjectId).not.toHaveBeenCalled();
    await shutdown(result);
  });
});

describe('export authentication', () => {
  /** Returns the header map the trace exporter was configured with. */
  function traceHeaders(): Partial<Record<string, string>> | undefined {
    return vi.mocked(OTLPTraceExporter).mock.calls[0][0]?.headers;
  }

  it('should send the bearer token the auth client signs with', async () => {
    const result = await getGcpExporters({
      enableTracing: true,
      googleAuth: {
        authClient: new FakeAuthClient('first-token'),
        projectId: PROJECT_ID,
      },
    });

    expect(traceHeaders()?.['Authorization']).toBe('Bearer first-token');
    await shutdown(result);
  });

  it('should export without a token when the credentials cannot be read', async () => {
    const authClient = new FakeAuthClient();
    vi.spyOn(authClient, 'getRequestHeaders').mockRejectedValue(
      new Error('The token endpoint is unreachable.'),
    );

    const result = await getGcpExporters({
      enableTracing: true,
      googleAuth: {authClient, projectId: PROJECT_ID},
    });

    expect(traceHeaders()?.['Authorization']).toBe('');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read credentials'),
      expect.anything(),
    );
    await shutdown(result);
  });

  it('should export without a token when the credentials sign nothing', async () => {
    const authClient = new FakeAuthClient();
    vi.spyOn(authClient, 'getRequestHeaders').mockResolvedValue(new Headers());

    const result = await getGcpExporters({
      enableTracing: true,
      googleAuth: {authClient, projectId: PROJECT_ID},
    });

    expect(traceHeaders()?.['Authorization']).toBe('');
    await shutdown(result);
  });

  it('should refresh the bearer token between exports', async () => {
    const authClient = new FakeAuthClient('first-token');
    const result = await getGcpExporters({
      enableTracing: true,
      googleAuth: {authClient, projectId: PROJECT_ID},
    });

    authClient.token = 'second-token';

    // The exporter re-reads the header map before every export, and that read
    // is what schedules the refresh.
    await vi.waitFor(() =>
      expect(traceHeaders()?.['Authorization']).toBe('Bearer second-token'),
    );
    await shutdown(result);
  });
});

describe('log record export', () => {
  it('should hand a named, resource-tagged record to the exporter', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', PROJECT_NUMBER);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const exported: ReadableLogRecord[] = [];
    vi.mocked(OTLPLogExporter.prototype.export).mockImplementation(
      (records, resultCallback) => {
        exported.push(...records);
        resultCallback({code: EXPORT_SUCCESS});
      },
    );
    const result = await getGcpExporters({
      enableLogging: true,
      googleAuth: {authClient: new FakeAuthClient(), projectId: PROJECT_ID},
    });
    const [processor] = result.logRecordProcessors ?? [];
    if (!processor) {
      expect.fail('getGcpExporters installed no log record processor');
    }
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({'service.version': '42'}),
      processors: [processor],
    });

    provider.getLogger('guide').emit({body: 'a log line', eventName: 'a.b'});
    await processor.forceFlush();

    // The whole batching path runs: only the network call is stubbed.
    expect(exported).toHaveLength(1);
    expect(exported[0].attributes).toEqual({
      'event.name': 'a.b',
      'gcp.log_name': 'aiplatform.googleapis.com/reasoning_engine_stdout',
      'service.version': '42',
    });
    expect(exported[0].body).toBe('a log line');
    expect(exported[0].resource.attributes['reasoning_engine_id']).toBe(
      PROJECT_NUMBER,
    );
    await shutdown(result);
  });
});

describe('mutual TLS without a certificate', () => {
  let home: string;

  beforeEach(async () => {
    // An empty home has no gcloud context-aware metadata, so the real
    // certificate lookup finds nothing. `os.homedir()` reads `HOME` on POSIX
    // and `USERPROFILE` on Windows.
    home = await mkdtemp(join(tmpdir(), 'adk-telemetry-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(async () => {
    await rm(home, {recursive: true, force: true});
  });

  it.each(['auto', 'always'])(
    'should stay on the plain endpoint when no certificate resolves (%s)',
    async (setting) => {
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', setting);

      const result = await getGcpExporters({
        enableTracing: true,
        googleAuth: {authClient: new FakeAuthClient(), projectId: PROJECT_ID},
      });

      // The mutual-TLS endpoint rejects a connection that presents no
      // certificate, which would drop all telemetry. adk-python selects it
      // anyway; this port does not.
      const config = vi.mocked(OTLPTraceExporter).mock.calls[0][0];
      expect(config?.url).toBe('https://telemetry.googleapis.com/v1/traces');
      expect(config?.httpAgentOptions).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('No context-aware client certificate'),
      );
      await shutdown(result);
    },
  );
});

describe('project number conversion', () => {
  /**
   * Returns the `resource_container` the log processor pins records to.
   *
   * The project arrives through Application Default Credentials, which is the
   * path that converts a project number into a project id.
   */
  async function pinnedResourceContainer(
    authClient: FakeAuthClient,
  ): Promise<AttributeValue | undefined> {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', PROJECT_NUMBER);
    vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue(authClient);
    const result = await getGcpExporters({enableLogging: true});
    const [processor] = result.logRecordProcessors ?? [];
    if (!processor) {
      expect.fail('getGcpExporters installed no log record processor');
    }
    const {forwarded} = emitLogRecord(processor);
    await shutdown(result);
    return forwarded.resource.attributes['resource_container'];
  }

  it('should convert a project number into a project ID on Agent Engine', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', PROJECT_NUMBER);
    const authClient = new FakeAuthClient();
    const request = vi
      .spyOn(authClient, 'request')
      .mockResolvedValue(gaxiosResponse({projectId: 'resolved-project'}));

    await expect(pinnedResourceContainer(authClient)).resolves.toBe(
      'projects/resolved-project',
    );
    expect(request).toHaveBeenCalledWith({
      url: `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT_NUMBER}`,
    });
  });

  it('should keep the project number when the lookup names no project', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', PROJECT_NUMBER);
    const authClient = new FakeAuthClient();
    vi.spyOn(authClient, 'request').mockResolvedValue(gaxiosResponse({}));

    await expect(pinnedResourceContainer(authClient)).resolves.toBe(
      `projects/${PROJECT_NUMBER}`,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('should keep the project number when the lookup fails', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', PROJECT_NUMBER);

    await expect(pinnedResourceContainer(new FakeAuthClient())).resolves.toBe(
      `projects/${PROJECT_NUMBER}`,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to convert project number to project ID'),
      expect.anything(),
    );
  });

  it('should not look the project up off Agent Engine', async () => {
    const authClient = new FakeAuthClient();
    const request = vi.spyOn(authClient, 'request');

    await expect(pinnedResourceContainer(authClient)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('should take a supplied project at its word', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', PROJECT_NUMBER);
    const authClient = new FakeAuthClient();
    const request = vi.spyOn(authClient, 'request');
    const getClient = vi.spyOn(GoogleAuth.prototype, 'getClient');

    const result = await getGcpExporters({
      enableLogging: true,
      googleAuth: {authClient, projectId: PROJECT_ID},
    });
    const [processor] = result.logRecordProcessors ?? [];
    if (!processor) {
      expect.fail('getGcpExporters installed no log record processor');
    }
    const {forwarded} = emitLogRecord(processor);
    await shutdown(result);

    // A caller that resolved the project already gets no second lookup, so
    // the id it passed to getGcpResource is the id the log records carry.
    expect(forwarded.resource.attributes['resource_container']).toBe(
      `projects/${PROJECT_ID}`,
    );
    expect(request).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('getGcpResource', () => {
  it('should detect GCP resources using gcpDetector', () => {
    const resource = getGcpResource(PROJECT_ID);

    expect(resource.attributes['cloud.platform']).toBe('gcp_kubernetes_engine');
  });

  it('should skip the GCP detector on Agent Engine', () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', PROJECT_NUMBER);

    const resource = getGcpResource(PROJECT_ID);

    // The detector would otherwise clobber the deployment's own attributes.
    expect(resource.attributes['cloud.platform']).toBe('gcp.agent_engine');
  });
});
