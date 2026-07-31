/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TraceExporter} from '@google-cloud/opentelemetry-cloud-trace-exporter';
import {
  ChannelCredentials,
  credentials as grpcCredentials,
  Metadata,
} from '@grpc/grpc-js';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-grpc';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {
  detectResources,
  envDetector,
  Resource,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from '@opentelemetry/resources';
import {
  MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {AuthClient, GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';

import {OtelExportersConfig, OTelHooks} from './setup.js';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

const GCP_CREDENTIALS_ERROR_MESSAGE =
  'Cannot obtain Application Default Credentials. OTel GCP metric export is ' +
  'disabled. Please run `gcloud auth application-default login` or attach a ' +
  'service account to enable it.';

/** OTLP endpoint of the Google Cloud Telemetry API. */
const TELEMETRY_ENDPOINT = 'https://telemetry.googleapis.com';

/** Resource attribute the Telemetry API routes ingested metrics on. */
const GCP_PROJECT_ID_ATTRIBUTE = 'gcp.project_id';

/** Cloud Monitoring rejects sample periods below five seconds. */
const METRIC_EXPORT_INTERVAL_MS = 5000;

/**
 * Resolves the GCP project from Application Default Credentials.
 *
 * Callers that assemble the telemetry pipeline themselves need this to build
 * the resource, because the Telemetry API takes the destination project as a
 * resource attribute rather than an exporter argument.
 *
 * @param auth credentials to resolve the project from, defaulting to
 *   Application Default Credentials.
 * @returns the project id, or undefined when it cannot be determined.
 */
export async function getGcpProjectId(
  auth: GoogleAuth = new GoogleAuth(),
): Promise<string | undefined> {
  try {
    const projectId = await auth.getProjectId();
    return projectId || undefined;
  } catch (_e: unknown) {
    return undefined;
  }
}

async function getGcpAuthClient(
  auth: GoogleAuth,
): Promise<AuthClient | undefined> {
  try {
    return await auth.getClient();
  } catch (_e: unknown) {
    return undefined;
  }
}

/**
 * Builds the channel credentials the OTLP exporter authenticates each export
 * RPC with.
 *
 * Uses a metadata generator rather than `createFromGoogleCredential`, which
 * reads the client's headers with `Object.keys`: `google-auth-library` v10
 * resolves `getRequestHeaders` to a WHATWG `Headers` instance, whose own
 * enumerable keys are empty, so that path would send unauthenticated requests.
 */
function createChannelCredentials(authClient: AuthClient): ChannelCredentials {
  const callCredentials = grpcCredentials.createFromMetadataGenerator(
    (options, callback) => {
      authClient
        .getRequestHeaders(options.service_url)
        .then((headers) => {
          const metadata = new Metadata();
          headers.forEach((value, key) => metadata.add(key, value));
          callback(null, metadata);
        })
        .catch((e: unknown) => {
          callback(e instanceof Error ? e : new Error(String(e)));
        });
    },
  );
  return grpcCredentials.combineChannelCredentials(
    grpcCredentials.createSsl(),
    callCredentials,
  );
}

function createGcpMetricReader(authClient: AuthClient): MetricReader {
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: TELEMETRY_ENDPOINT,
      credentials: createChannelCredentials(authClient),
    }),
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
  });
}

export async function getGcpExporters(
  config: OtelExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    // enableCloudLogging = false,
  } = config;

  const auth = new GoogleAuth();
  const projectId = await getGcpProjectId(auth);
  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  const metricReaders: MetricReader[] = [];
  if (enableMetrics) {
    const authClient = await getGcpAuthClient(auth);
    if (authClient) {
      metricReaders.push(createGcpMetricReader(authClient));
    } else {
      logger.warn(GCP_CREDENTIALS_ERROR_MESSAGE);
    }
  }

  return {
    spanProcessors: enableTracing
      ? [new BatchSpanProcessor(new TraceExporter({projectId}))]
      : [],
    metricReaders,
    logRecordProcessors: [],
  };
}

/**
 * Returns the OTel resource to install alongside the GCP exporters.
 *
 * Attributes detected later override those detected earlier:
 * 1. `gcp.project_id` from `projectId`. The Telemetry API routes ingested
 *    metrics on this attribute; without it the export has no destination
 *    project, so pass the value {@link getGcpProjectId} resolves.
 * 2. A generated `service.instance.id`, which supplies the `instance` label
 *    Managed Service for Prometheus requires and rejects points without.
 * 3. `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`. This is the only way to
 *    supply `location` off Google Cloud, where no detector can infer it.
 * 4. The GCP detector, which fills in the platform, region and zone when ADK
 *    runs on GCE, GKE or Cloud Run.
 *
 * @param projectId project to attribute the telemetry to.
 */
export function getGcpResource(projectId?: string): Resource {
  const detected = detectResources({
    detectors: [serviceInstanceIdDetector, envDetector, gcpDetector],
  });
  if (!projectId) {
    return detected;
  }
  return resourceFromAttributes({
    [GCP_PROJECT_ID_ATTRIBUTE]: projectId,
  }).merge(detected);
}
