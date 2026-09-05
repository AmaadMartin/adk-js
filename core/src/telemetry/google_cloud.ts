/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {detectResources, Resource} from '@opentelemetry/resources';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {getAgentEngineMetricsSetup} from './agent_engine.js';
import {MIN_EXPORT_INTERVAL_MS} from './agent_engine_metric_exporter.js';
import {createGcpMetricExporter} from './gcp_metric_exporter.js';
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

/** Builds the Cloud Monitoring metric reader, loading its exporter on demand. */
async function createCloudMetricReader(
  projectId: string,
): Promise<PeriodicExportingMetricReader> {
  return new PeriodicExportingMetricReader({
    exporter: await createGcpMetricExporter(projectId),
    exportIntervalMillis: MIN_EXPORT_INTERVAL_MS,
  });
}

/**
 * Builds the metric reader and span processors Google Cloud export needs.
 *
 * On Agent Engine the request-driven reader replaces the periodic one, and
 * brings the span processor that drives it.
 */
async function createMetricHooks(projectId: string): Promise<OTelHooks> {
  const agentEngine = await getAgentEngineMetricsSetup();
  if (agentEngine === undefined) {
    return {metricReaders: [await createCloudMetricReader(projectId)]};
  }
  return {
    metricReaders: [agentEngine.reader],
    spanProcessors: [agentEngine.spanProcessor],
  };
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

  const metricHooks = enableMetrics ? await createMetricHooks(projectId) : {};

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
