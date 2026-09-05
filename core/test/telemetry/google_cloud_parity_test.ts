/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `tests/unittests/telemetry/test_google_cloud.py` on adk-python
 * `main`. Every `it()` keeps the Python test name so the two suites can be
 * compared by name.
 */

import {
  DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT,
  DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
  DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
  DEFAULT_TELEMETRY_LOGS_ENDPOINT,
  DEFAULT_TELEMETRY_METRICS_ENDPOINT,
  DEFAULT_TELEMETRY_TRACES_ENDPOINT,
  getGcpExporters,
  getGcpResource,
  OTelHooks,
} from '@google/adk';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {LogRecordProcessor} from '@opentelemetry/sdk-logs';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
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
  ClientCertSource,
  defaultClientCertSource,
  getApiEndpoint,
  useClientCertEffective,
} from '../../src/utils/mtls_utils.js';

import {emitLogRecord, FakeAuthClient} from './telemetry_fixtures.js';

vi.mock('@opentelemetry/exporter-trace-otlp-http');
vi.mock('@opentelemetry/exporter-metrics-otlp-http');
vi.mock('@opentelemetry/exporter-logs-otlp-http');

// The real detector reaches for the GCE metadata server.
vi.mock('@opentelemetry/resource-detector-gcp', () => ({
  gcpDetector: {detect: () => ({attributes: {}})},
}));

vi.mock('@opentelemetry/sdk-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opentelemetry/sdk-metrics')>()),
  PeriodicExportingMetricReader: vi.fn(),
}));

// Only the filesystem and subprocess half is stubbed; the endpoint choice and
// the environment parsing stay real, because they are under test here.
vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/mtls_utils.js')>()),
  defaultClientCertSource: vi.fn(),
}));

/** Every variable these tests read, cleared before each of them. */
const MANAGED_ENV = [
  'GCLOUD_PROJECT',
  'GCP_DEFAULT_LOG_NAME',
  'GOOGLE_API_USE_CLIENT_CERTIFICATE',
  'GOOGLE_API_USE_MTLS_ENDPOINT',
  'GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SERVICE_NAME',
];

const PROJECT_ID = 'my-project';
const CERT_SOURCE: ClientCertSource = {cert: 'a-cert', key: 'a-key'};
const BOOLEANS = [true, false];

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    vi.stubEnv(name, undefined);
  }
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.mocked(defaultClientCertSource).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Builds the exporters with a fake credential, as a deployment would. */
async function exportersFor(
  config: {
    enableTracing?: boolean;
    enableMetrics?: boolean;
    enableLogging?: boolean;
  },
  authClient = new FakeAuthClient(),
): Promise<OTelHooks> {
  return getGcpExporters({
    ...config,
    googleAuth: {authClient, projectId: PROJECT_ID},
  });
}

/** Releases the batch processors' timers and exporters. */
async function shutdown(hooks: OTelHooks): Promise<void> {
  for (const processor of hooks.spanProcessors ?? []) {
    await processor.shutdown();
  }
  for (const processor of hooks.logRecordProcessors ?? []) {
    await processor.shutdown();
  }
}

/** Returns the single log record processor the exporters install. */
async function logsProcessor(): Promise<LogRecordProcessor> {
  const hooks = await exportersFor({enableLogging: true});
  const [processor] = hooks.logRecordProcessors ?? [];
  if (!processor) {
    expect.fail('getGcpExporters installed no log record processor');
  }
  return processor;
}

describe('get_gcp_exporters', () => {
  const flagCases = BOOLEANS.flatMap((enableTracing) =>
    BOOLEANS.flatMap((enableMetrics) =>
      BOOLEANS.map((enableLogging) => ({
        enableTracing,
        enableMetrics,
        enableLogging,
      })),
    ),
  );

  it.each(flagCases)(
    'test_get_gcp_exporters (tracing=$enableTracing metrics=$enableMetrics logging=$enableLogging)',
    async (flags) => {
      const hooks = await exportersFor(flags);

      expect(hooks.spanProcessors).toHaveLength(flags.enableTracing ? 1 : 0);
      expect(hooks.metricReaders).toHaveLength(flags.enableMetrics ? 1 : 0);
      expect(hooks.logRecordProcessors).toHaveLength(
        flags.enableLogging ? 1 : 0,
      );
      await shutdown(hooks);
    },
  );
});

describe('get_gcp_resource', () => {
  const projectIdCases = [
    {inArgument: 'project_id_in_arg', inEnvironment: 'project_id_on_env'},
    {inArgument: 'project_id_in_arg', inEnvironment: undefined},
    {inArgument: undefined, inEnvironment: 'project_id_on_env'},
    {inArgument: undefined, inEnvironment: undefined},
  ];

  it.each(projectIdCases)(
    'test_get_gcp_resource (argument=$inArgument environment=$inEnvironment)',
    ({inArgument, inEnvironment}) => {
      if (inEnvironment !== undefined) {
        vi.stubEnv(
          'OTEL_RESOURCE_ATTRIBUTES',
          `gcp.project_id=${inEnvironment}`,
        );
      }

      const resource = getGcpResource(inArgument);

      expect(resource.attributes['gcp.project_id']).toBe(
        inEnvironment ?? inArgument,
      );
    },
  );

  it('test_get_gcp_resource_is_not_agent_engine_off_agent_engine', () => {
    const resource = getGcpResource(PROJECT_ID);

    // Whatever the platform is, the GCP detector decides it, not us.
    expect(resource.attributes['cloud.platform']).not.toBe('gcp.agent_engine');
    expect(resource.attributes['cloud.resource_id']).toBeUndefined();
    expect(resource.attributes['gcp.project_id']).toBe(PROJECT_ID);
  });

  it('test_get_gcp_resource_describes_the_agent_engine_deployment', () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    const resource = getGcpResource(PROJECT_ID);

    expect(resource.attributes['cloud.platform']).toBe('gcp.agent_engine');
    expect(resource.attributes['service.name']).toBe('1234567890');
    expect(resource.attributes['cloud.region']).toBe('us-central1');
    expect(resource.attributes['cloud.account.id']).toBe(PROJECT_ID);
    // Contributed by `defaultResource()`, as they were before OTLP export.
    expect(resource.attributes['telemetry.sdk.language']).toBe('nodejs');
    expect(resource.attributes['telemetry.sdk.name']).toBe('opentelemetry');
  });

  it('test_get_gcp_resource_sets_standard_cloud_resource_id', () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    const resource = getGcpResource(PROJECT_ID);

    // The Agent Engine dashboard filters on the OTel-standard key.
    expect(resource.attributes['cloud.resource_id']).toBe(
      '//aiplatform.googleapis.com/projects/my-project' +
        '/locations/us-central1/reasoningEngines/1234567890',
    );
    expect(resource.attributes['cloud.resource.id']).toBeUndefined();
  });
});

describe('mTLS configuration', () => {
  it('test_use_client_cert_effective_from_env', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    expect(useClientCertEffective()).toBe(true);

    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');
    expect(useClientCertEffective()).toBe(false);

    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'maybe');
    expect(useClientCertEffective()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Environment variable `GOOGLE_API_USE_CLIENT_CERTIFICATE` must be ' +
          'either `true` or `false`',
      ),
    );
  });

  const traceEndpointCases = [
    {
      setting: 'auto',
      certSource: CERT_SOURCE,
      expected: DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
    },
    {
      setting: 'auto',
      certSource: undefined,
      expected: DEFAULT_TELEMETRY_TRACES_ENDPOINT,
    },
    {
      setting: 'always',
      certSource: undefined,
      expected: DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
    },
    {
      setting: 'never',
      certSource: CERT_SOURCE,
      expected: DEFAULT_TELEMETRY_TRACES_ENDPOINT,
    },
    {
      setting: 'invalid',
      certSource: undefined,
      expected: DEFAULT_TELEMETRY_TRACES_ENDPOINT,
    },
  ];

  it.each(traceEndpointCases)(
    'test_get_api_endpoint (setting=$setting cert=$certSource)',
    ({setting, certSource, expected}) => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', setting);

      expect(
        getApiEndpoint(
          certSource,
          DEFAULT_TELEMETRY_TRACES_ENDPOINT,
          DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
        ),
      ).toBe(expected);

      if (setting === 'invalid') {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'Environment variable `GOOGLE_API_USE_MTLS_ENDPOINT` must be one of',
          ),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  const metricEndpointCases = [
    {
      setting: 'auto',
      certSource: CERT_SOURCE,
      expected: DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
    },
    {
      setting: 'auto',
      certSource: undefined,
      expected: DEFAULT_TELEMETRY_METRICS_ENDPOINT,
    },
    {
      setting: 'always',
      certSource: undefined,
      expected: DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
    },
    {
      setting: 'never',
      certSource: CERT_SOURCE,
      expected: DEFAULT_TELEMETRY_METRICS_ENDPOINT,
    },
  ];

  it.each(metricEndpointCases)(
    'test_get_api_endpoint_for_metrics (setting=$setting cert=$certSource)',
    ({setting, certSource, expected}) => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', setting);

      expect(
        getApiEndpoint(
          certSource,
          DEFAULT_TELEMETRY_METRICS_ENDPOINT,
          DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
        ),
      ).toBe(expected);
    },
  );
});

describe('span exporter', () => {
  it('test_get_gcp_span_exporter_mtls', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    vi.mocked(defaultClientCertSource).mockResolvedValue(CERT_SOURCE);

    const hooks = await exportersFor({enableTracing: true});

    const config = vi.mocked(OTLPTraceExporter).mock.calls[0][0];
    expect(config?.url).toBe(DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT);
    expect(config?.httpAgentOptions).toEqual(CERT_SOURCE);
    await shutdown(hooks);
  });
});

describe('metric exporter', () => {
  it('test_get_gcp_otlp_metric_exporter_mtls', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    vi.mocked(defaultClientCertSource).mockResolvedValue(CERT_SOURCE);

    await exportersFor({enableMetrics: true});

    const config = vi.mocked(OTLPMetricExporter).mock.calls[0][0];
    expect(config?.url).toBe(DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT);
    expect(config?.httpAgentOptions).toEqual(CERT_SOURCE);
  });

  it('test_get_gcp_otlp_metric_exporter_no_mtls', async () => {
    await exportersFor({enableMetrics: true});

    const config = vi.mocked(OTLPMetricExporter).mock.calls[0][0];
    expect(config?.url).toBe(DEFAULT_TELEMETRY_METRICS_ENDPOINT);
    expect(config?.httpAgentOptions).toBeUndefined();
    expect(defaultClientCertSource).not.toHaveBeenCalled();
  });

  it('test_get_gcp_otlp_metric_exporter_sends_agent_engine_user_agent', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY', '1');

    await exportersFor({enableMetrics: true});

    const headers = vi.mocked(OTLPMetricExporter).mock.calls[0][0]?.headers;
    expect(headers?.['User-Agent']).toMatch(/^Vertex-Agent-Engine\//);
  });

  it('test_get_gcp_otlp_metric_exporter_uses_default_credentials', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'adc-project');
    const getClient = vi
      .spyOn(GoogleAuth.prototype, 'getClient')
      .mockResolvedValue(new FakeAuthClient('adc-token'));

    await getGcpExporters({enableMetrics: true});

    expect(getClient).toHaveBeenCalled();
    const headers = vi.mocked(OTLPMetricExporter).mock.calls[0][0]?.headers;
    expect(headers?.['Authorization']).toBe('Bearer adc-token');
  });

  it('test_get_gcp_metrics_exporter_wraps_otlp_in_periodic_reader', async () => {
    await exportersFor({enableMetrics: true});

    const options = vi.mocked(PeriodicExportingMetricReader).mock.calls[0][0];
    expect(options.exporter).toBe(
      vi.mocked(OTLPMetricExporter).mock.instances[0],
    );
    expect(options.exportIntervalMillis).toBe(5000);
  });
});

describe('logs exporter', () => {
  it('test_get_gcp_logs_exporter_targets_telemetry_api', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY', '1');

    const processor = await logsProcessor();

    const config = vi.mocked(OTLPLogExporter).mock.calls[0][0];
    expect(config?.url).toBe(DEFAULT_TELEMETRY_LOGS_ENDPOINT);
    expect(config?.headers?.['User-Agent']).toMatch(/^Vertex-Agent-Engine\//);
    await processor.shutdown();
  });

  it('test_get_gcp_logs_exporter_mtls', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    vi.mocked(defaultClientCertSource).mockResolvedValue(CERT_SOURCE);

    const processor = await logsProcessor();

    const config = vi.mocked(OTLPLogExporter).mock.calls[0][0];
    expect(config?.url).toBe(DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT);
    expect(config?.httpAgentOptions).toEqual(CERT_SOURCE);
    await processor.shutdown();
  });

  const logNameCases = [
    {agentEngineId: undefined, logNameEnv: undefined, expected: 'adk-otel'},
    {
      agentEngineId: undefined,
      logNameEnv: 'custom-log',
      expected: 'custom-log',
    },
    {
      agentEngineId: '1234567890',
      logNameEnv: undefined,
      expected: 'aiplatform.googleapis.com/reasoning_engine_stdout',
    },
  ];

  it.each(logNameCases)(
    'test_logs_exporter_falls_back_to_default_log_name (engine=$agentEngineId env=$logNameEnv)',
    async ({agentEngineId, logNameEnv, expected}) => {
      if (agentEngineId !== undefined) {
        vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', agentEngineId);
      }
      if (logNameEnv !== undefined) {
        vi.stubEnv('GCP_DEFAULT_LOG_NAME', logNameEnv);
      }
      const processor = await logsProcessor();

      const {forwarded} = emitLogRecord(processor);

      expect(forwarded.attributes['gcp.log_name']).toBe(expected);
      await processor.shutdown();
    },
  );

  it('test_logs_exporter_preserves_event_name_as_label', async () => {
    const processor = await logsProcessor();

    const {forwarded} = emitLogRecord(processor, {
      eventName: 'gen_ai.client.inference.operation.details',
    });

    expect(forwarded.attributes).toEqual({
      'event.name': 'gen_ai.client.inference.operation.details',
      'gcp.log_name': 'adk-otel',
    });
    // Cloud Logging names the log after `eventName` ahead of `gcp.log_name`,
    // which would scatter one log per event type.
    expect(forwarded.eventName).toBeUndefined();
    await processor.shutdown();
  });

  it('test_logs_exporter_keeps_explicit_log_name', async () => {
    const processor = await logsProcessor();

    const {forwarded} = emitLogRecord(processor, {
      attributes: {'gcp.log_name': 'my-log'},
    });

    expect(forwarded.attributes['gcp.log_name']).toBe('my-log');
    await processor.shutdown();
  });

  it('test_logs_processor_pins_reasoning_engine_monitored_resource', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const processor = await logsProcessor();

    const {attributes} = emitLogRecord(processor).forwarded.resource;

    expect(attributes['gcp.resource_type']).toBe(
      'aiplatform.googleapis.com/ReasoningEngine',
    );
    expect(attributes['location']).toBe('us-central1');
    expect(attributes['reasoning_engine_id']).toBe('1234567890');
    // A bare project id makes Cloud Logging build an invalid log name and the
    // export fails with HTTP 400.
    expect(attributes['resource_container']).toBe('projects/my-project');
    // Traces and metrics must not see the type hint: the metrics pipeline
    // reads the same key and would move Agent Engine off its resource.
    expect(
      getGcpResource(PROJECT_ID).attributes['gcp.resource_type'],
    ).toBeUndefined();
    await processor.shutdown();
  });

  it('test_logs_processor_pins_without_a_location', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
    const processor = await logsProcessor();

    const {attributes} = emitLogRecord(processor).forwarded.resource;

    expect(attributes['gcp.resource_type']).toBe(
      'aiplatform.googleapis.com/ReasoningEngine',
    );
    // Every log line from one deployment must land on the same resource, so
    // the label set cannot depend on which variables happen to be set.
    expect(attributes['location']).toBe('');
    await processor.shutdown();
  });

  it('test_logs_processor_republishes_service_version_as_a_label', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
    const processor = await logsProcessor();

    const {forwarded} = emitLogRecord(processor, {
      resource: resourceFromAttributes({'service.version': '42'}),
    });

    expect(forwarded.attributes['service.version']).toBe('42');
    await processor.shutdown();
  });

  it('test_logs_processor_leaves_the_resource_alone_off_agent_engine', async () => {
    const processor = await logsProcessor();

    const {forwarded} = emitLogRecord(processor);

    expect(forwarded.resource.attributes['gcp.resource_type']).toBeUndefined();
    expect(forwarded.attributes['service.version']).toBeUndefined();
    await processor.shutdown();
  });

  it('test_logs_processor_does_not_mutate_the_record_it_is_handed', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
    const processor = await logsProcessor();

    const {incoming, forwarded} = emitLogRecord(processor, {
      eventName: 'gen_ai.choice',
      attributes: {a: '1'},
      resource: resourceFromAttributes({'service.version': '42'}),
    });

    expect(forwarded).not.toBe(incoming);
    expect(incoming.eventName).toBe('gen_ai.choice');
    expect(incoming.attributes).toEqual({a: '1'});
    expect(incoming.resource.attributes['gcp.resource_type']).toBeUndefined();
    expect(forwarded.attributes['event.name']).toBe('gen_ai.choice');
    await processor.shutdown();
  });
});
