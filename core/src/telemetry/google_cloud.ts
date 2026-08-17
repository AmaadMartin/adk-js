/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MetricExporter} from '@google-cloud/opentelemetry-cloud-monitoring-exporter';
import {TraceExporter} from '@google-cloud/opentelemetry-cloud-trace-exporter';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {detectResources, Resource} from '@opentelemetry/resources';
import {
  MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';

import {
  getAgentEngineMetricsSetup,
  MIN_EXPORT_INTERVAL_MS,
} from './agent_engine_metrics.js';
import {OtelExportersConfig, OTelHooks} from './setup.js';

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
    spanProcessors.push(new BatchSpanProcessor(new TraceExporter({projectId})));
  }
  if (enableMetrics) {
    // On Agent Engine a timer-driven reader is starved between requests, so
    // the request-driven reader replaces it there. Its span processor is what
    // drives the reader, so it is registered under metrics, not tracing.
    const agentEngineMetrics = getAgentEngineMetricsSetup(
      () => new MetricExporter({projectId}),
    );
    if (agentEngineMetrics) {
      metricReaders.push(agentEngineMetrics.reader);
      spanProcessors.push(agentEngineMetrics.spanProcessor);
    } else {
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: new MetricExporter({projectId}),
          exportIntervalMillis: MIN_EXPORT_INTERVAL_MS,
        }),
      );
    }
  }

  return {spanProcessors, metricReaders, logRecordProcessors: []};
}

export function getGcpResource(): Resource {
  return detectResources({detectors: [gcpDetector]});
}
