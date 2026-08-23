/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import type {Resource} from '@opentelemetry/resources';
import {detectResources} from '@opentelemetry/resources';
import type {MetricReader} from '@opentelemetry/sdk-metrics';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import type {SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  getAgentEngineMetricsSetup,
  MIN_EXPORT_INTERVAL_MS,
} from './agent_engine_metrics.js';
import type {OtelExportersConfig, OTelHooks} from './setup.js';

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

/**
 * Loads the Cloud Monitoring metric exporter, an optional peer.
 *
 * The class is handed back rather than an instance because the Agent Engine
 * setup below needs a factory it can call per reader. The dynamic `import()`
 * is cached by the runtime, so calling this twice costs one load.
 */
async function loadMetricExporter(): Promise<
  typeof import('@google-cloud/opentelemetry-cloud-monitoring-exporter').MetricExporter
> {
  const {MetricExporter} = await loadOptionalPeer(
    {
      packageName: '@google-cloud/opentelemetry-cloud-monitoring-exporter',
      feature: 'getGcpExporters({enableMetrics: true})',
    },
    () => import('@google-cloud/opentelemetry-cloud-monitoring-exporter'),
  );
  return MetricExporter;
}

/** Builds the Cloud Monitoring metric reader, loading its exporter on demand. */
async function createCloudMetricReader(
  projectId: string,
): Promise<PeriodicExportingMetricReader> {
  const MetricExporter = await loadMetricExporter();
  return new PeriodicExportingMetricReader({
    exporter: new MetricExporter({projectId}),
    exportIntervalMillis: MIN_EXPORT_INTERVAL_MS,
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

  const projectId = await getGcpProjectId();
  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  const spanProcessors: SpanProcessor[] = [];
  const metricReaders: MetricReader[] = [];

  if (enableTracing) {
    spanProcessors.push(await createCloudTraceProcessor(projectId));
  }
  if (enableMetrics) {
    // On Agent Engine a timer-driven reader is starved between requests, so
    // the request-driven reader replaces it there. Its span processor is what
    // drives the reader, so it is registered under metrics, not tracing.
    const MetricExporter = await loadMetricExporter();
    const agentEngineMetrics = getAgentEngineMetricsSetup(
      () => new MetricExporter({projectId}),
    );
    if (agentEngineMetrics) {
      metricReaders.push(agentEngineMetrics.reader);
      spanProcessors.push(agentEngineMetrics.spanProcessor);
    } else {
      metricReaders.push(await createCloudMetricReader(projectId));
    }
  }

  return {spanProcessors, metricReaders, logRecordProcessors: []};
}

export function getGcpResource(): Resource {
  return detectResources({detectors: [gcpDetector]});
}
