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
import {detectResources, Resource} from '@opentelemetry/resources';
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

/** Cloud Monitoring rejects sample periods below five seconds. */
const METRIC_EXPORT_INTERVAL_MS = 5000;

async function getGcpProjectId(auth: GoogleAuth): Promise<string | undefined> {
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

export function getGcpResource(): Resource {
  return detectResources({detectors: [gcpDetector]});
}
