/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {detectResources, Resource} from '@opentelemetry/resources';
import {
  PeriodicExportingMetricReader,
  PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  buildRequestDrivenMetrics,
  MIN_EXPORT_INTERVAL_MS,
} from './agent_engine_metric_exporter.js';
import {OtelExportersConfig, OTelHooks} from './setup.js';

/** Set by the Vertex AI Agent Runtime to the deployed agent's resource id. */
const AGENT_ENGINE_ID_ENV = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

async function getGcpProjectId(): Promise<string | undefined> {
  try {
    const auth = new GoogleAuth();
    const projectId = await auth.getProjectId();
    return projectId || undefined;
  } catch (_e: unknown) {
    return undefined;
  }
}

/** Builds the Cloud Trace span processor, loading its exporter on demand. */
async function createCloudTraceProcessor(
  projectId: string,
): Promise<BatchSpanProcessor> {
  const {TraceExporter} = await loadOptionalPeer(
    {
      packageName: '@google-cloud/opentelemetry-cloud-trace-exporter',
      feature: 'getGcpExporters({enableTracing: true})',
    },
    () => import('@google-cloud/opentelemetry-cloud-trace-exporter'),
  );
  return new BatchSpanProcessor(new TraceExporter({projectId}));
}

/** Builds the Cloud Monitoring metric exporter, loading it on demand. */
async function createCloudMetricExporter(
  projectId: string,
): Promise<PushMetricExporter> {
  const {MetricExporter} = await loadOptionalPeer(
    {
      packageName: '@google-cloud/opentelemetry-cloud-monitoring-exporter',
      feature: 'getGcpExporters({enableMetrics: true})',
    },
    () => import('@google-cloud/opentelemetry-cloud-monitoring-exporter'),
  );
  return new MetricExporter({projectId});
}

/**
 * Builds the metric hooks for Cloud Monitoring.
 *
 * On the Vertex AI Agent Runtime this is the request-driven reader, plus the
 * span processor that drives it: the runtime throttles CPU between requests, so
 * a periodic reader's timer is starved. Everywhere else it is a periodic reader
 * at the shared minimum interval.
 */
async function createCloudMetricHooks(projectId: string): Promise<OTelHooks> {
  const exporter = await createCloudMetricExporter(projectId);
  if (!process.env[AGENT_ENGINE_ID_ENV]) {
    return {
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: MIN_EXPORT_INTERVAL_MS,
        }),
      ],
    };
  }
  const {reader, spanProcessor} = buildRequestDrivenMetrics(exporter);
  return {metricReaders: [reader], spanProcessors: [spanProcessor]};
}

export async function getGcpExporters(
  config: OtelExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    // enableCloudLogging = false,
  } = config;

  const projectId = await getGcpProjectId();
  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  const metricHooks = enableMetrics
    ? await createCloudMetricHooks(projectId)
    : {};

  return {
    spanProcessors: [
      ...(enableTracing ? [await createCloudTraceProcessor(projectId)] : []),
      ...(metricHooks.spanProcessors ?? []),
    ],
    metricReaders: metricHooks.metricReaders ?? [],
    logRecordProcessors: [],
  };
}

export function getGcpResource(): Resource {
  return detectResources({detectors: [gcpDetector]});
}
