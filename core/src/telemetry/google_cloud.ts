/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogAttributes} from '@opentelemetry/api-logs';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {
  defaultResource,
  detectResources,
  emptyResource,
  envDetector,
  Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LogRecordExporter,
  LogRecordProcessor,
  SdkLogRecord,
} from '@opentelemetry/sdk-logs';
import {
  MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {AuthClient, GoogleAuth} from 'google-auth-library';

import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {
  ClientCertSource,
  defaultClientCertSource,
  getApiEndpoint,
  useClientCertEffective,
} from '../utils/mtls_utils.js';
import {version} from '../version.js';

import {OtelExportersConfig, OTelHooks} from './setup.js';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

const PROJECT_NUMBER_ERROR_MESSAGE =
  'Failed to convert project number to project ID. Your traces and logs may ' +
  'not be associated. To fix this, consider enabling the resource manager ' +
  'API and redeploying your agent.';

/** Where traces are exported when mutual TLS is off. */
export const DEFAULT_TELEMETRY_TRACES_ENDPOINT =
  'https://telemetry.googleapis.com/v1/traces';
/** Where traces are exported when mutual TLS is on. */
export const DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/traces';
/** Where metrics are exported when mutual TLS is off. */
export const DEFAULT_TELEMETRY_METRICS_ENDPOINT =
  'https://telemetry.googleapis.com/v1/metrics';
/** Where metrics are exported when mutual TLS is on. */
export const DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/metrics';
/** Where log records are exported when mutual TLS is off. */
export const DEFAULT_TELEMETRY_LOGS_ENDPOINT =
  'https://telemetry.googleapis.com/v1/logs';
/** Where log records are exported when mutual TLS is on. */
export const DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/logs';

/**
 * Shortest metric export interval Cloud Monitoring accepts.
 *
 * Points written more often than this are rejected as duplicates.
 */
const MIN_EXPORT_INTERVAL_MS = 5000;

const CLOUD_RESOURCE_MANAGER_ENDPOINT =
  'https://cloudresourcemanager.googleapis.com';

const AGENT_ENGINE_ID_ENV = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const AGENT_ENGINE_LOCATION_ENV = 'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION';
const AGENT_ENGINE_REVISION_ENV =
  'GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID';
const AGENT_ENGINE_TELEMETRY_ENV = 'GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY';
const LOCATION_ENV = 'GOOGLE_CLOUD_LOCATION';
const GCP_DEFAULT_LOG_NAME_ENV = 'GCP_DEFAULT_LOG_NAME';

const ADK_OTEL = 'adk-otel';
// OTel logs used to be written to stdout on Agent Engine. Keeping the log name
// keeps existing log filters working.
const DEFAULT_AGENT_ENGINE_LOG_NAME =
  'aiplatform.googleapis.com/reasoning_engine_stdout';
const REASONING_ENGINE_RESOURCE_TYPE =
  'aiplatform.googleapis.com/ReasoningEngine';

const AUTHORIZATION_HEADER = 'Authorization';
const USER_AGENT_HEADER = 'User-Agent';

const CLOUD_ACCOUNT_ID = 'cloud.account.id';
const CLOUD_PLATFORM = 'cloud.platform';
const CLOUD_PROVIDER = 'cloud.provider';
const CLOUD_REGION = 'cloud.region';
// `cloud.resource_id` is not in the stable semantic-convention package yet.
const CLOUD_RESOURCE_ID = 'cloud.resource_id';
const EVENT_NAME = 'event.name';
const GCP_LOG_NAME = 'gcp.log_name';
const GCP_PROJECT_ID = 'gcp.project_id';
const GCP_RESOURCE_TYPE = 'gcp.resource_type';
const LOCATION = 'location';
const REASONING_ENGINE_ID = 'reasoning_engine_id';
const RESOURCE_CONTAINER = 'resource_container';
const SERVICE_INSTANCE_ID = 'service.instance.id';
const SERVICE_NAME = 'service.name';
const SERVICE_VERSION = 'service.version';

/** Credentials and project the GCP exporters report telemetry with. */
export interface GoogleAuthConfig {
  /** Auth client that signs each export. Defaults to the ADC client. */
  authClient?: AuthClient;
  /** Project telemetry is reported to. Defaults to the ADC project. */
  projectId?: string;
}

/** Options for {@link getGcpExporters}. */
export interface GcpExportersConfig extends OtelExportersConfig {
  /** Credentials and project to export with, instead of resolving ADC. */
  googleAuth?: GoogleAuthConfig;
}

/** Credentials and project, once both are known. */
export interface ResolvedGoogleAuth {
  /** Auth client that signs each export. */
  authClient: AuthClient;
  /** Project telemetry is reported to, as a project id. */
  projectId: string;
}

/** The OTLP HTTP exporter options this module sets. */
interface OtlpExporterConfig {
  url: string;
  headers: Record<string, string>;
  httpAgentOptions?: ClientCertSource;
}

/** Returns the bearer token `authClient` currently signs requests with. */
async function readAuthorization(authClient: AuthClient): Promise<string> {
  try {
    const headers = await authClient.getRequestHeaders();
    return headers.get(AUTHORIZATION_HEADER) ?? '';
  } catch (e: unknown) {
    logger.warn('Failed to read credentials for telemetry export.', e);
    return '';
  }
}

/**
 * Returns the export headers, with an `Authorization` that stays fresh.
 *
 * The OTLP HTTP exporters re-read their header map before every export, so
 * reading the property is what schedules the next token refresh. A timer would
 * have to be torn down; a read does not. `getRequestHeaders` caches the token
 * and only calls the credential endpoint when it is close to expiring.
 */
async function createExportHeaders(
  authClient: AuthClient,
): Promise<Record<string, string>> {
  // Agent Engine attributes its export traffic with a `User-Agent`, once the
  // deployment has opted in to telemetry.
  const headers: Record<string, string> = process.env[
    AGENT_ENGINE_TELEMETRY_ENV
  ]
    ? {[USER_AGENT_HEADER]: `Vertex-Agent-Engine/${version}`}
    : {};
  let authorization = await readAuthorization(authClient);
  let refreshing = false;

  Object.defineProperty(headers, AUTHORIZATION_HEADER, {
    enumerable: true,
    get(): string {
      if (!refreshing) {
        refreshing = true;
        void readAuthorization(authClient).then((refreshed) => {
          authorization = refreshed;
          refreshing = false;
        });
      }
      return authorization;
    },
  });
  return headers;
}

/**
 * Returns the endpoint to export to, and the certificate to present.
 *
 * This is the Node shape of Python's in-place `configure_mtls_channel()`: the
 * certificate travels back to the caller instead of being installed on a
 * session. When a certificate is asked for but cannot be resolved, export
 * stays on the plain endpoint. The mutual-TLS endpoint rejects a connection
 * that presents no certificate, which would drop all telemetry.
 */
async function getTelemetryEndpoint(
  defaultEndpoint: string,
  mtlsEndpoint: string,
): Promise<{endpoint: string; clientCertSource?: ClientCertSource}> {
  if (!useClientCertEffective()) {
    return {endpoint: defaultEndpoint};
  }
  const clientCertSource = await defaultClientCertSource();
  if (!clientCertSource) {
    logger.warn(
      'No context-aware client certificate is available; exporting telemetry ' +
        `to ${defaultEndpoint} without mutual TLS.`,
    );
    return {endpoint: defaultEndpoint};
  }
  return {
    endpoint: getApiEndpoint(clientCertSource, defaultEndpoint, mtlsEndpoint),
    clientCertSource,
  };
}

/** Builds the OTLP exporter options for one signal. */
async function createOtlpExporterConfig(
  authClient: AuthClient,
  defaultEndpoint: string,
  mtlsEndpoint: string,
): Promise<OtlpExporterConfig> {
  const {endpoint, clientCertSource} = await getTelemetryEndpoint(
    defaultEndpoint,
    mtlsEndpoint,
  );
  return {
    url: endpoint,
    headers: await createExportHeaders(authClient),
    httpAgentOptions: clientCertSource,
  };
}

/** Builds the span processor that exports to telemetry.googleapis.com. */
async function getGcpSpanExporter(
  authClient: AuthClient,
): Promise<SpanProcessor> {
  return new BatchSpanProcessor(
    new OTLPTraceExporter(
      await createOtlpExporterConfig(
        authClient,
        DEFAULT_TELEMETRY_TRACES_ENDPOINT,
        DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
      ),
    ),
  );
}

/** Builds the periodic reader that drains the OTLP metric exporter. */
async function getGcpMetricsExporter(
  authClient: AuthClient,
): Promise<MetricReader> {
  const exporter = new OTLPMetricExporter(
    await createOtlpExporterConfig(
      authClient,
      DEFAULT_TELEMETRY_METRICS_ENDPOINT,
      DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
    ),
  );
  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: MIN_EXPORT_INTERVAL_MS,
  });
}

/** Builds the log record processor that exports to telemetry.googleapis.com. */
async function getGcpLogsExporter(
  authClient: AuthClient,
  projectId: string,
): Promise<LogRecordProcessor> {
  return new GcpBatchLogRecordProcessor(
    new OTLPLogExporter(
      await createOtlpExporterConfig(
        authClient,
        DEFAULT_TELEMETRY_LOGS_ENDPOINT,
        DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT,
      ),
    ),
    projectId,
  );
}

/**
 * Returns the MonitoredResource hints Cloud Logging needs on Agent Engine.
 *
 * Empty off Agent Engine. These are logs-only: `gcp.resource_type` also steers
 * metric ingestion, so putting it on the resource traces and metrics share
 * would move Agent Engine metrics off their monitored resource.
 *
 * @param projectId Project the agent reports telemetry to.
 */
function agentEngineLogResource(projectId: string): Resource {
  const agentEngineId = process.env[AGENT_ENGINE_ID_ENV];
  if (!agentEngineId) {
    return emptyResource();
  }
  const location =
    process.env[AGENT_ENGINE_LOCATION_ENV] || process.env[LOCATION_ENV];
  return resourceFromAttributes({
    // Cloud Logging otherwise detects the resource as `generic_task`.
    [GCP_RESOURCE_TYPE]: REASONING_ENGINE_RESOURCE_TYPE,
    [LOCATION]: location ?? '',
    [REASONING_ENGINE_ID]: agentEngineId,
    // Without `projects/`, telemetry.googleapis.com returns a 4xx.
    [RESOURCE_CONTAINER]: `projects/${projectId}`,
  });
}

/**
 * Returns a shallow copy of `record` carrying `attributes` and `resource`.
 *
 * `SdkLogRecord` declares `attributes` and `resource` readonly, and the SDK's
 * `LogRecordImpl` serves `body`, `eventName` and `severityText` from prototype
 * accessors, so neither an object literal nor a spread reproduces a record.
 * Copying the property descriptors onto an object with the same prototype
 * does, and is the analogue of the reference implementation's `copy.copy()`.
 */
function copyLogRecord(
  record: SdkLogRecord,
  attributes: LogAttributes,
  resource: Resource,
): SdkLogRecord {
  const copy: SdkLogRecord = Object.create(Object.getPrototypeOf(record), {
    ...Object.getOwnPropertyDescriptors(record),
    attributes: {value: attributes, enumerable: true},
    resource: {value: resource, enumerable: true},
    // Cloud Logging derives the log name from `eventName` in preference to
    // `gcp.log_name`, which would scatter records over one log per event type.
    // The name survives as the `event.name` attribute.
    eventName: {value: undefined, enumerable: true, writable: true},
    // `LogRecordImpl` derives this from the attribute count, which the rewrite
    // above changes; the record's own count is the truthful one.
    droppedAttributesCount: {
      value: record.droppedAttributesCount,
      enumerable: true,
      writable: true,
    },
  });
  return copy;
}

/**
 * Batching processor that keeps Cloud Logging log names and labels stable.
 *
 * telemetry.googleapis.com files an unnamed record under a generic `otlp` log.
 * This processor names every record before it is batched, and on Agent Engine
 * pins the MonitoredResource the previous stdout pipeline produced.
 */
class GcpBatchLogRecordProcessor extends BatchLogRecordProcessor {
  private readonly logResource: Resource;
  private readonly defaultLogName: string;

  constructor(exporter: LogRecordExporter, projectId: string) {
    super(exporter);
    this.logResource = agentEngineLogResource(projectId);
    this.defaultLogName =
      process.env[GCP_DEFAULT_LOG_NAME_ENV] ||
      (process.env[AGENT_ENGINE_ID_ENV]
        ? DEFAULT_AGENT_ENGINE_LOG_NAME
        : ADK_OTEL);
  }

  override onEmit(logRecord: SdkLogRecord): void {
    // The provider hands the same record to every registered processor, so the
    // rewrites below go on a copy of our own.
    const attributes: LogAttributes = {...logRecord.attributes};
    if (logRecord.eventName) {
      attributes[EVENT_NAME] ??= logRecord.eventName;
    }
    attributes[GCP_LOG_NAME] ??= this.defaultLogName;

    const resource = logRecord.resource.merge(this.logResource);
    // Resource attributes are dropped once ingested as a MonitoredResource, so
    // the version has to travel as a label to stay queryable.
    const serviceVersion = resource.attributes[SERVICE_VERSION];
    if (serviceVersion !== undefined) {
      attributes[SERVICE_VERSION] ??= serviceVersion;
    }

    super.onEmit(copyLogRecord(logRecord, attributes, resource));
  }
}

/**
 * Returns the resource attributes describing the Agent Engine deployment.
 *
 * Undefined off Agent Engine.
 *
 * @param projectId Project the agent reports telemetry to.
 */
function maybeDetectAgentEngineResource(
  projectId?: string,
): Resource | undefined {
  const agentEngineId = process.env[AGENT_ENGINE_ID_ENV];
  if (!agentEngineId) {
    return undefined;
  }
  const location =
    process.env[AGENT_ENGINE_LOCATION_ENV] || process.env[LOCATION_ENV];
  const attributes: Record<string, string> = {
    [CLOUD_PROVIDER]: 'gcp',
    [CLOUD_PLATFORM]: 'gcp.agent_engine',
    [SERVICE_NAME]: agentEngineId,
    [SERVICE_VERSION]: process.env[AGENT_ENGINE_REVISION_ENV] ?? '',
    [CLOUD_REGION]: location ?? '',
  };
  if (projectId && location) {
    attributes[CLOUD_RESOURCE_ID] =
      `//aiplatform.googleapis.com/projects/${projectId}` +
      `/locations/${location}/reasoningEngines/${agentEngineId}`;
  }
  return resourceFromAttributes(attributes);
}

/**
 * Turns a project number into a project ID so logs and traces line up.
 *
 * Keeps the value it was given when the lookup fails.
 */
async function resolveProjectId(
  authClient: AuthClient,
  projectId: string,
): Promise<string> {
  try {
    const {data} = await authClient.request<{projectId?: string}>({
      url: `${CLOUD_RESOURCE_MANAGER_ENDPOINT}/v3/projects/${projectId}`,
    });
    return data.projectId ?? projectId;
  } catch (e: unknown) {
    logger.warn(PROJECT_NUMBER_ERROR_MESSAGE, e);
    return projectId;
  }
}

/**
 * Resolves the credentials and the project to export telemetry with.
 *
 * Application Default Credentials answer whichever half `googleAuth` leaves
 * out, and on Agent Engine the project number they report is turned into a
 * project id. A caller that supplies both halves is taken at its word, so pass
 * the result of this call to both {@link getGcpExporters} and
 * {@link getGcpResource} to keep the two describing the same project.
 *
 * Undefined when no project can be determined. It never throws.
 *
 * @param googleAuth Credentials and project to use instead of ADC.
 */
export async function resolveGoogleAuth(
  googleAuth?: GoogleAuthConfig,
): Promise<ResolvedGoogleAuth | undefined> {
  const {authClient, projectId} = googleAuth ?? {};
  if (authClient && projectId) {
    return {authClient, projectId};
  }

  let resolvedClient = authClient;
  let resolvedProject = projectId;
  try {
    const auth = new GoogleAuth();
    resolvedClient ??= await auth.getClient();
    resolvedProject ??= await auth.getProjectId();
  } catch (e: unknown) {
    logger.debug('Failed to resolve Application Default Credentials.', e);
  }
  if (!resolvedClient || !resolvedProject) {
    return undefined;
  }

  if (process.env[AGENT_ENGINE_ID_ENV]) {
    resolvedProject = await resolveProjectId(resolvedClient, resolvedProject);
  }
  return {authClient: resolvedClient, projectId: resolvedProject};
}

/**
 * Returns the GCP OTel exporters to install in the app.
 *
 * Traces, metrics and log records are exported over OTLP to
 * telemetry.googleapis.com. Nothing is returned, and a warning is logged, when
 * no project can be determined.
 *
 * @param config Which signals to export, and the credentials to export with.
 */
export async function getGcpExporters(
  config: GcpExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    enableLogging = false,
  } = config;

  const auth = await resolveGoogleAuth(config.googleAuth);
  if (!auth) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }
  const {authClient, projectId} = auth;

  return {
    spanProcessors: enableTracing ? [await getGcpSpanExporter(authClient)] : [],
    metricReaders: enableMetrics
      ? [await getGcpMetricsExporter(authClient)]
      : [],
    logRecordProcessors: enableLogging
      ? [await getGcpLogsExporter(authClient, projectId)]
      : [],
  };
}

/**
 * Returns the OTel resource to report telemetry under.
 *
 * Attributes merged later win:
 *
 * 1. `service.instance.id`, plus `gcp.project_id` and `cloud.account.id` from
 *    `projectId`.
 * 2. On Agent Engine, the attributes describing the deployment.
 * 3. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`.
 * 4. Off Agent Engine, the GCP detector's attributes for GCE, GKE or Cloud
 *    Run. It is skipped on Agent Engine, where it would clobber the
 *    deployment's own attributes.
 *
 * @param projectId Project to report telemetry to. `OTEL_RESOURCE_ATTRIBUTES`
 *   can override it.
 */
export function getGcpResource(projectId?: string): Resource {
  const attributes: Record<string, string> = {
    [SERVICE_INSTANCE_ID]: `${randomUUID().replaceAll('-', '')}-${process.pid}`,
  };
  if (projectId !== undefined) {
    attributes[GCP_PROJECT_ID] = projectId;
    attributes[CLOUD_ACCOUNT_ID] = projectId;
  }

  const agentEngineResource = maybeDetectAgentEngineResource(projectId);
  // `defaultResource()` contributes the `telemetry.sdk.*` attributes the Agent
  // Engine resource has always carried.
  let resource = agentEngineResource
    ? defaultResource()
        .merge(resourceFromAttributes(attributes))
        .merge(agentEngineResource)
    : resourceFromAttributes(attributes);

  resource = resource.merge(detectResources({detectors: [envDetector]}));

  if (!agentEngineResource) {
    resource = resource.merge(detectResources({detectors: [gcpDetector]}));
  }
  return resource;
}
